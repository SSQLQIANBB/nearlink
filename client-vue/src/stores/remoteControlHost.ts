import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '@/config/env';
import { getRemoteSessionIce, getRemoteControlRelease } from '@/api/remoteControl';
import { confirmRemoteNativeRequest } from '@/services/remoteDeviceNative';
import { validRemoteConnecting, type RemoteConnecting } from '@/services/remoteControlAdapter';
import { validateRemoteIceConfiguration } from '@/services/remoteControlIce';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';
import { mediaOccupancy, type MediaClaim } from '@/services/mediaOccupancy';
import { createRequestId } from '@/utils/requestId';
import { useAuthStore } from './auth';
import type { RemoteSignalAck, RemoteStateSnapshot } from '@/services/remoteControlSignaling';

export const useRemoteControlHostStore = defineStore('remoteControlHost', () => {
  const phase = ref<'offline' | 'starting' | 'online' | 'pending' | 'connecting' | 'active'>('offline');
  const deviceId = ref<string | null>(null);
  const scope = ref<'view' | 'control'>('view');
  const error = ref('');
  const session = shallowRef<RemoteStateSnapshot | null>(null);
  let socket: Socket | null = null, generation = 0, claim: MediaClaim | null = null;
  let approval: AbortController | null = null, heartbeat: ReturnType<typeof setInterval> | undefined;
  let queue = Promise.resolve(), queued = 0, nativeStarted = false, connecting: RemoteConnecting | null = null;
  let nativeCleanup: Promise<unknown> = Promise.resolve();
  const auth = useAuthStore();
  function failure(message: string, cause: unknown) {
    const code = cause instanceof Error ? cause.message : cause;
    return typeof code === 'string' && /^REMOTE_[A-Z_]{1,64}$/.test(code)
      ? `${message}（${code}）` : message;
  }
  function current(value: number) { return generation === value && !!socket?.connected; }
  function stop(reason = '') {
    generation++; approval?.abort(); approval = null;
    clearInterval(heartbeat); heartbeat = undefined;
    socket?.removeAllListeners(); socket?.disconnect(); socket = null;
    claim?.release(); claim = null; session.value = null; connecting = null;
    nativeStarted = false; phase.value = 'offline'; deviceId.value = null;
    queue = Promise.resolve(); queued = 0;
    if (reason) error.value = reason;
    if (isTauri()) nativeCleanup = nativeCleanup.catch(() => {}).then(() => invoke('remote_control_stop'));
    void nativeCleanup.catch(() => { error.value = '本机停止确认失败，请重新启动客户端后再开启协助。'; });
  }
  registerRemoteControlCleanup(() => stop());
  async function command(event: string, payload: Record<string, unknown>, revision = session.value?.revision) {
    const transport = socket, id = session.value?.sessionId;
    if (!transport?.connected || !id || revision === undefined) throw new Error('REMOTE_DISCONNECTED');
    const result = await transport.timeout(5000).emitWithAck(event, { protocolVersion: 1, requestId: createRequestId(),
      sessionId: id, expectedRevision: revision, connectionGeneration: 1, payload }) as RemoteSignalAck;
    if (!result?.ok || result.sessionId !== id || !Number.isSafeInteger(result.revision)) throw new Error(result?.code || 'REMOTE_INVALID_ACK');
  }
  async function native(command: Record<string, unknown>) {
    const id = session.value?.sessionId;
    if (!id || !nativeStarted) throw new Error('REMOTE_HOST_NOT_STARTED');
    await invoke('remote_control_host_command', { sessionId: id, command });
  }
  function enqueue(value: number, action: () => Promise<void>) {
    if (!current(value)) return;
    if (++queued > 64) { stop('远控消息积压，已停止协助。'); return; }
    queue = queue.then(async () => { if (current(value)) await action(); }).catch(cause => {
      if (current(value)) stop(failure('远控连接中断，已停止屏幕共享和键鼠控制。', cause));
    }).finally(() => { if (generation === value) queued--; });
  }
  async function start(id: string) {
    if (!isTauri() || phase.value !== 'offline' || !auth.token) return;
    error.value = ''; phase.value = 'starting'; const value = ++generation;
    try {
      await nativeCleanup;
      if (generation !== value) return;
      const release = await getRemoteControlRelease();
      if (generation !== value) return;
      if (!release.desktopHostEnabled || !release.releasedPlatforms.includes('macos')) throw new Error('REMOTE_NOT_RELEASED');
      const transport = io(`${publicEnv.socketUrl}/remote-control`, { path: '/meeting', transports: ['websocket'],
        reconnection: false, autoConnect: false, auth: { token: auth.token, role: 'host', platform: 'macos', deviceId: id } });
      socket = transport; deviceId.value = id;
      transport.on('disconnect', () => { if (generation === value) stop('设备已离线，远程协助已停止。'); });
      transport.on('connect_error', () => { if (generation === value) stop('无法上线，请检查设备登记、登录状态和服务器配置。'); });
      transport.on('remote:presence-challenge', message => {
        if (!current(value)) return;
        void invoke('remote_control_presence', { proof: message?.proof }).then(async proof => {
          if (!current(value)) return;
          const response = await transport.timeout(5000).emitWithAck('remote:presence', { proof });
          if (!response?.ok) throw new Error('REMOTE_PRESENCE_REJECTED');
          if (phase.value === 'starting') phase.value = 'online';
        }).catch(() => { if (current(value)) stop('设备上线校验失败，请检查客户端版本、设备身份和系统权限。'); });
      });
      transport.on('remote:state', (state: RemoteStateSnapshot) => {
        if (!current(value) || !session.value || state?.sessionId !== session.value.sessionId) return;
        if (!Number.isSafeInteger(state.revision) || state.revision < session.value.revision) return;
        if (state.state === 'ended') { stop(); return; }
        const paused = session.value.scope === 'control' && state.scope === 'view';
        session.value = state; scope.value = state.scope;
        if (state.state === 'active') phase.value = 'active';
        if (paused && nativeStarted) enqueue(value, () => native({ type: 'pause' }));
      });
      transport.on('remote:ended', message => { if (current(value) && message?.sessionId === session.value?.sessionId) stop(); });
      transport.on('remote:approval', message => {
        if (!current(value) || approval || (session.value && session.value.sessionId !== message?.sessionId)) return;
        if (!message || typeof message.sessionId !== 'string' || !Number.isSafeInteger(message.revision)) { stop('协助请求无效。'); return; }
        claim ||= mediaOccupancy.acquire('remote-control', `host:${id}`, () => stop());
        if (!claim) { stop('正在通话或共享屏幕，请结束后再开启协助。'); return; }
        session.value = { sessionId: message.sessionId, state: message.state, revision: message.revision, scope: message.scope,
          authorizationRevision: message.authorizationRevision, controlEpoch: message.controlEpoch };
        if (phase.value !== 'active') phase.value = 'pending';
        const cancel = new AbortController(); approval = cancel;
        void confirmRemoteNativeRequest(message.proof, cancel.signal).then(async proof => {
          if (current(value) && !cancel.signal.aborted) await command('remote:consent', { proof }, message.revision);
        }).catch((cause: unknown) => {
          if (current(value)) stop(cause instanceof Error && cause.message === 'REMOTE_NATIVE_TIMEOUT'
            ? '45 秒内未完成本机确认，协助已取消。请重新上线后发起请求，并在 ToDesk 窗口确认。'
            : '本机授权未完成，协助已取消。');
        })
          .finally(() => { if (approval === cancel) approval = null; });
      });
      transport.on('remote:connecting', message => enqueue(value, async () => {
        if (!validRemoteConnecting(message) || message.sessionId !== session.value?.sessionId || message.host.endpointId !== id
          || message.host.connectionId !== transport.id || nativeStarted) throw new Error('REMOTE_CONNECTING_INVALID');
        connecting = message; phase.value = 'connecting';
        const ice = await getRemoteSessionIce(message.sessionId);
        if (!current(value)) return;
        validateRemoteIceConfiguration(ice, message.hardDeadline);
        const events = new Channel<{ sessionId: string; type: string; payload: Record<string, any> }>();
        events.onmessage = event => {
          if (!current(value) || event.sessionId !== session.value?.sessionId) return;
          if (event.type === 'ended') { stop(failure('本机远控已停止。', event.payload?.reason)); return; }
          enqueue(value, async () => {
            if (event.type === 'native-fact') await command('remote:native-fact', { proof: event.payload.proof });
            else if (event.type === 'answer') await command('remote:signal', { type: 'answer', sdp: event.payload.sdp,
              negotiationId: connecting!.negotiationId, connectionGeneration: 1 });
            else if (event.type === 'ice') await command('remote:signal', { type: 'candidate', candidate: event.payload,
              negotiationId: connecting!.negotiationId, connectionGeneration: 1 });
          });
        };
        await invoke('remote_control_start_host', { iceProof: ice.proof, events });
        if (!current(value)) return; // stop() already scheduled teardown after the in-flight native launch.
        nativeStarted = true;
        heartbeat = setInterval(() => { if (current(value)) void native({ type: 'heartbeat' }).catch(() => { if (current(value)) stop('本机远控进程已停止。'); }); }, 500);
      }));
      transport.on('remote:signal', message => enqueue(value, async () => {
        if (message?.sessionId !== session.value?.sessionId || message?.negotiationId !== connecting?.negotiationId) throw new Error('REMOTE_SIGNAL_INVALID');
        if (message.type === 'offer') await native({ type: 'offer', negotiation_id: message.negotiationId, sdp: message.sdp });
        else if (message.type === 'candidate') await native({ type: 'candidate', candidate: message.candidate.candidate, sdp_m_line_index: message.candidate.sdpMLineIndex });
        else throw new Error('REMOTE_SIGNAL_INVALID');
      }));
      for (const type of ['connection-proof', 'lease'] as const) transport.on(`remote:${type}`, message => enqueue(value, async () => {
        if (message?.sessionId !== session.value?.sessionId) throw new Error('REMOTE_PROOF_INVALID');
        await native({ type: type === 'lease' ? 'lease' : 'connection', proof: message.proof });
      }));
      transport.connect();
    } catch { if (generation === value) stop('当前版本尚不能开启本机协助，请完成客户端与服务器配置后重试。'); }
  }
  return { phase, deviceId, scope, error, session, start, stop };
});
