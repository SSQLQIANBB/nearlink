import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '@/config/env';
import { getRemoteSessionIce, getRemoteControlRelease, type RemoteAssistanceCredentials } from '@/api/remoteControl';
import { confirmRemoteNativeRequest, probeRemoteDeviceSupport } from '@/services/remoteDeviceNative';
import { validRemoteConnecting, type RemoteConnecting } from '@/services/remoteControlAdapter';
import { validateRemoteIceConfiguration } from '@/services/remoteControlIce';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';
import { mediaOccupancy, type MediaClaim } from '@/services/mediaOccupancy';
import { createRequestId } from '@/utils/requestId';
import { useAuthStore } from './auth';
import type { RemoteSignalAck, RemoteStateSnapshot } from '@/services/remoteControlSignaling';

export const useRemoteControlHostStore = defineStore('remoteControlHost', () => {
  const phase = ref<'offline' | 'starting' | 'online' | 'pending' | 'connecting' | 'active' | 'ending'>(
    'offline',
  );
  const deviceId = ref<string | null>(null);
  const scope = ref<'view' | 'control'>('view');
  const error = ref('');
  const credentials = shallowRef<RemoteAssistanceCredentials | null>(null);
  // Keep the last issued code visible when assistance stops; it grants no access.
  const displayedDeviceCode = ref('');
  const refreshingCredentials = ref(false);
  const session = shallowRef<RemoteStateSnapshot | null>(null);
  let socket: Socket | null = null,
    generation = 0,
    sessionGeneration = 0,
    claim: MediaClaim | null = null;
  let approval: AbortController | null = null,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let queue = Promise.resolve(),
    queued = 0,
    nativeStarted = false,
    connecting: RemoteConnecting | null = null;
  let nativeCleanup: Promise<unknown> = Promise.resolve();
  const auth = useAuthStore();
  function failure(message: string, cause: unknown) {
    const code = cause instanceof Error ? cause.message : cause;
    const nativeErrors: Record<string, string> = {
      PRESENCE_SIGNING_KEY_UNTRUSTED: '远控服务器签名密钥不在客户端信任列表中，请检查客户端版本与服务器签名配置是否配套。',
      INVALID_PRESENCE_CHALLENGE: '设备上线凭据的签名或内容校验失败，请检查客户端与服务器版本及签名配置。',
      REMOTE_ENGINE_MANIFEST_CHANGED: '安装包与引擎清单不匹配，请完整重装同一版本。',
      REMOTE_ENGINE_CONTENT_CHANGED: '引擎文件内容校验失败，请检查文件是否被替换或损坏。',
      REMOTE_ENGINE_UNLISTED_RESOURCE: '引擎目录出现安装清单之外的文件或目录，请检查安装目录。',
      REMOTE_ENGINE_RESOURCE_UNREADABLE: '引擎资源无法读取，可能缺失、被占用或访问受限。',
      REMOTE_ENGINE_RESOURCE_UNSAFE: '引擎资源的文件类型、链接或权限不符合安装要求。',
      REMOTE_ENGINE_BUNDLE_REJECTED: '引擎资源完整性检查未通过，已停止协助。',
    };
    if (typeof code === 'string' && nativeErrors[code]) return `${nativeErrors[code]}（${code}）`;
    return typeof code === 'string' && /^[A-Z][A-Z_]{1,80}$/.test(code)
      ? `${message}（${code}）`
      : message;
  }
  function current(value: number) {
    return generation === value && !!socket?.connected;
  }
  function clearSession() {
    sessionGeneration++;
    approval?.abort();
    approval = null;
    clearInterval(heartbeat);
    heartbeat = undefined;
    claim?.release();
    claim = null;
    session.value = null;
    connecting = null;
    nativeStarted = false;
    // Drain an in-flight native launch before stopping it or accepting another session.
    const pending = queue;
    queue = Promise.resolve();
    queued = 0;
    if (isTauri())
      nativeCleanup = nativeCleanup.catch(() => {}).then(async () => {
        await pending.catch(() => {});
        await invoke('remote_control_stop');
      });
  }
  function stop(reason = '') {
    generation++;
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
    clearSession();
    phase.value = 'offline';
    deviceId.value = null;
    refreshingCredentials.value = false;
    if (reason) error.value = reason;
    void nativeCleanup.catch(() => {
      error.value = '本机停止确认失败，请重新启动客户端后再开启协助。';
    });
  }
  async function endSession(reason = '', notify = true) {
    if (!session.value) return;
    const value = generation;
    const ended = notify ? command('remote:end', {}) : Promise.resolve();
    clearSession();
    phase.value = 'ending';
    error.value = reason;
    try {
      await Promise.all([ended, nativeCleanup]);
      if (current(value) && phase.value === 'ending') phase.value = 'online';
    } catch (cause) {
      if (current(value)) stop(failure('结束协助未能确认，本机已离线。', cause));
    }
  }
  registerRemoteControlCleanup(() => {
    stop();
    displayedDeviceCode.value = '';
    credentials.value = null;
  });
  async function refreshCredentials(rotate = true) {
    if (!socket?.connected || refreshingCredentials.value || session.value) return;
    const value = generation;
    refreshingCredentials.value = true;
    const resume = !rotate ? credentials.value : null;
    if (rotate) credentials.value = null;
    try {
      const response = await socket.timeout(5000).emitWithAck('remote:credentials', resume ? { resume } : {});
      if (!current(value)) return;
      const item = response?.credentials;
      if (!response?.ok) throw new Error(response?.code || 'REMOTE_CREDENTIALS_UNAVAILABLE');
      if (!item || !/^\d{9}$/.test(item.deviceCode) || !/^[a-z2-9]{10}$/.test(item.temporaryPassword))
        throw new Error('REMOTE_CREDENTIALS_INVALID');
      credentials.value = item;
      displayedDeviceCode.value = item.deviceCode;
      error.value = '';
    } finally {
      if (generation === value) refreshingCredentials.value = false;
    }
  }
  async function command(
    event: string,
    payload: Record<string, unknown>,
    revision = session.value?.revision,
  ) {
    const transport = socket,
      id = session.value?.sessionId;
    if (!transport?.connected || !id || revision === undefined)
      throw new Error('REMOTE_DISCONNECTED');
    const result = (await transport.timeout(5000).emitWithAck(event, {
      protocolVersion: 1,
      requestId: createRequestId(),
      sessionId: id,
      expectedRevision: revision,
      connectionGeneration: 1,
      payload,
    })) as RemoteSignalAck;
    if (!result?.ok || result.sessionId !== id || !Number.isSafeInteger(result.revision))
      throw new Error(result?.code || 'REMOTE_INVALID_ACK');
  }
  async function native(command: Record<string, unknown>) {
    const id = session.value?.sessionId;
    if (!id || !nativeStarted) throw new Error('REMOTE_HOST_NOT_STARTED');
    await invoke('remote_control_host_command', { sessionId: id, command });
  }
  function enqueue(value: number, action: (isCurrent: () => boolean) => Promise<void>) {
    const epoch = sessionGeneration;
    const isCurrent = () => current(value) && epoch === sessionGeneration && !!session.value;
    if (!isCurrent()) return;
    if (++queued > 64) {
      stop('远控消息积压，已停止协助。');
      return;
    }
    queue = queue
      .then(async () => {
        if (isCurrent()) await action(isCurrent);
      })
      .catch((cause) => {
        if (isCurrent()) void endSession(failure('远控连接中断，已停止屏幕共享和键鼠控制。', cause));
      })
      .finally(() => {
        if (isCurrent()) queued--;
      });
  }
  async function start(id: string) {
    if (!isTauri() || phase.value !== 'offline' || !auth.token) return;
    error.value = '';
    phase.value = 'starting';
    const value = ++generation;
    try {
      await nativeCleanup;
      if (generation !== value) return;
      const release = await getRemoteControlRelease();
      if (generation !== value) return;
      const support = await probeRemoteDeviceSupport();
      if (generation !== value) return;
      const platform = support.platform;
      if ((platform !== 'windows' && platform !== 'macos') ||
          !release.desktopHostEnabled || !release.releasedPlatforms.includes(platform))
        throw new Error('REMOTE_NOT_RELEASED');
      const transport = io(`${publicEnv.socketUrl}/remote-control`, {
        path: '/meeting',
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        auth: { token: auth.token, role: 'host', platform, deviceId: id },
      });
      socket = transport;
      deviceId.value = id;
      transport.on('disconnect', () => {
        if (generation === value) stop('设备已离线，远程协助已停止。');
      });
      transport.on('connect_error', (cause) => {
        if (generation !== value) return;
        stop(cause.message === 'REMOTE_SERVICE_UNAVAILABLE'
          ? '远控服务未就绪：后端缺少签名配置，请完成本地开发准备并重启后端。'
          : failure('无法连接远控服务，请检查登录状态与后端连接。', cause));
      });
      transport.on('remote:presence-challenge', (message) => {
        if (!current(value)) return;
        void invoke('remote_control_presence', { proof: message?.proof })
          .then(async (proof) => {
            if (!current(value)) return;
            const response = await transport
              .timeout(5000)
              .emitWithAck('remote:presence', { proof });
            if (!response?.ok) throw new Error(response?.code || 'REMOTE_PRESENCE_REJECTED');
            if (phase.value === 'starting') {
              await refreshCredentials(false);
              if (current(value)) phase.value = 'online';
            }
          })
          .catch((cause) => {
            if (current(value)) stop(failure('设备在线状态更新失败。', cause));
          });
      });
      transport.on('remote:state', (state: RemoteStateSnapshot) => {
        if (!current(value) || !session.value || state?.sessionId !== session.value.sessionId)
          return;
        if (!Number.isSafeInteger(state.revision) || state.revision < session.value.revision)
          return;
        if (state.state === 'ended') {
          void endSession('', false);
          return;
        }
        const paused = session.value.scope === 'control' && state.scope === 'view';
        session.value = state;
        scope.value = state.scope;
        if (state.state === 'active') phase.value = 'active';
        if (paused && nativeStarted) enqueue(value, () => native({ type: 'pause' }));
      });
      transport.on('remote:ended', (message) => {
        if (current(value) && message?.sessionId === session.value?.sessionId) void endSession('', false);
      });
      transport.on('remote:approval', async (message) => {
        if (phase.value === 'ending') {
          try { await nativeCleanup; }
          catch { return; } // endSession takes the host offline if cleanup fails.
        }
        if (
          !current(value) ||
          approval ||
          (session.value && session.value.sessionId !== message?.sessionId)
        )
          return;
        if (
          !message ||
          typeof message.sessionId !== 'string' ||
          !Number.isSafeInteger(message.revision)
        ) {
          stop('协助请求无效。');
          return;
        }
        claim ||= mediaOccupancy.acquire('remote-control', `host:${id}`, () => { void endSession(); });
        if (!claim) {
          stop('正在通话或共享屏幕，请结束后再开启协助。');
          return;
        }
        session.value = {
          sessionId: message.sessionId,
          state: message.state,
          revision: message.revision,
          scope: message.scope,
          authorizationRevision: message.authorizationRevision,
          controlEpoch: message.controlEpoch,
        };
        if (phase.value !== 'active') phase.value = 'pending';
        const cancel = new AbortController();
        approval = cancel;
        void confirmRemoteNativeRequest(message.proof, cancel.signal)
          .then(async (proof) => {
            if (current(value) && !cancel.signal.aborted)
              await command('remote:consent', { proof }, message.revision);
          })
          .catch((cause: unknown) => {
            if (current(value) && !cancel.signal.aborted)
              void endSession(
                cause instanceof Error && cause.message === 'REMOTE_NATIVE_TIMEOUT'
                  ? '45 秒内未完成本机确认，协助已取消。请重新发起请求，并在 NearLink 窗口确认。'
                  : '本机授权未完成，协助已取消。',
              );
          })
          .finally(() => {
            if (approval === cancel) approval = null;
          });
      });
      transport.on('remote:connecting', (message) => {
        if (message?.sessionId !== session.value?.sessionId) return;
        enqueue(value, async (isCurrent) => {
          if (
            !validRemoteConnecting(message) ||
            message.sessionId !== session.value?.sessionId ||
            message.host.endpointId !== id ||
            message.host.connectionId !== transport.id ||
            nativeStarted
          )
            throw new Error('REMOTE_CONNECTING_INVALID');
          connecting = message;
          phase.value = 'connecting';
          const ice = await getRemoteSessionIce(message.sessionId);
          if (!isCurrent()) return;
          validateRemoteIceConfiguration(ice, message.hardDeadline);
          const events = new Channel<{
            sessionId: string;
            type: string;
            payload: Record<string, any>;
          }>();
          events.onmessage = (event) => {
            if (!current(value) || event.sessionId !== session.value?.sessionId) return;
            if (event.type === 'ended') {
              void endSession(failure('本机远控已停止。', event.payload?.reason));
              return;
            }
            enqueue(value, async () => {
              if (event.type === 'native-fact')
                await command('remote:native-fact', { proof: event.payload.proof });
              else if (event.type === 'answer')
                await command('remote:signal', {
                  type: 'answer',
                  sdp: event.payload.sdp,
                  negotiationId: connecting!.negotiationId,
                  connectionGeneration: 1,
                });
              else if (event.type === 'ice')
                await command('remote:signal', {
                  type: 'candidate',
                  candidate: event.payload,
                  negotiationId: connecting!.negotiationId,
                  connectionGeneration: 1,
                });
            });
          };
          await invoke('remote_control_start_host', { iceProof: ice.proof, events });
          if (!isCurrent()) return;
          nativeStarted = true;
          heartbeat = setInterval(() => {
            if (isCurrent())
              void native({ type: 'heartbeat' }).catch(() => {
                if (isCurrent()) void endSession('本机远控进程已停止。');
              });
          }, 500);
        });
      });
      transport.on('remote:signal', (message) => {
        if (message?.sessionId !== session.value?.sessionId) return;
        enqueue(value, async () => {
          if (
            message?.sessionId !== session.value?.sessionId ||
            message?.negotiationId !== connecting?.negotiationId
          )
            throw new Error('REMOTE_SIGNAL_INVALID');
          if (message.type === 'offer')
            await native({
              type: 'offer',
              negotiation_id: message.negotiationId,
              sdp: message.sdp,
            });
          else if (message.type === 'candidate')
            await native({
              type: 'candidate',
              candidate: message.candidate.candidate,
              sdp_m_line_index: message.candidate.sdpMLineIndex,
            });
          else throw new Error('REMOTE_SIGNAL_INVALID');
        });
      });
      for (const type of ['connection-proof', 'lease'] as const)
        transport.on(`remote:${type}`, (message) => {
          if (message?.sessionId !== session.value?.sessionId) return;
          enqueue(value, async () => {
            if (message?.sessionId !== session.value?.sessionId)
              throw new Error('REMOTE_PROOF_INVALID');
            await native({ type: type === 'lease' ? 'lease' : 'connection', proof: message.proof });
          });
        });
      transport.connect();
    } catch {
      if (generation === value)
        stop('当前版本尚不能开启本机协助，请完成客户端与服务器配置后重试。');
    }
  }
  return { phase, deviceId, scope, error, session, credentials, displayedDeviceCode, refreshingCredentials, refreshCredentials, start, stop, endSession };
});
