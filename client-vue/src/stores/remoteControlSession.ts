import { validateRemoteIceConfiguration } from '@/services/remoteControlIce';
import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { getRemoteSessionIce, getRemoteSigningKeys, type RemoteTarget } from '@/api/remoteControl';
import { useAuthStore } from './auth';
import { useRemoteControlStore } from './remoteControl';
import { mediaOccupancy, type MediaClaim } from '@/services/mediaOccupancy';
import { SocketRemoteControllerAdapter, type RemoteControllerAdapter, type RemoteControllerEvent } from '@/services/remoteControlAdapter';
import { RemoteControlPeer, sdpSha256Fingerprint, type RemotePeerStats } from '@/services/remoteControlPeer';
import type { RemoteInputEvent } from '@/services/remoteControlInput';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';
import { RemoteTextCommitQueue } from '@/services/remoteTextCommit';
import { createRequestId } from '@/utils/requestId';

export const useRemoteControlSessionStore = defineStore('remoteControlSession', () => {
  const phase = ref<'idle' | 'requesting' | 'pending' | 'connecting' | 'active' | 'ended'>('idle');
  const device = shallowRef<RemoteTarget | null>(null);
  const sessionId = ref<string | null>(null);
  const stream = shallowRef<MediaStream | null>(null);
  const stats = shallowRef<RemotePeerStats | null>(null);
  const scope = ref<'view' | 'control'>('view');
  const inputArmed = ref(false);
  const needsApproval = ref(false);
  const textQueue = new RemoteTextCommitQueue();
  const statusMessage = ref('');
  const failureCode = ref('');
  const visible = computed(() => !['idle', 'ended'].includes(phase.value));
  let adapter: RemoteControllerAdapter | null = null;
  let peer: RemoteControlPeer | null = null;
  let claim: MediaClaim | null = null;
  let generation = 0;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let events = Promise.resolve();
  let queuedEvents = 0;
  let queuedBytes = 0;
  let videoElement: HTMLVideoElement | null = null;

  async function start(target: RemoteTarget, requestedScope: 'view' | 'control') {
    const capabilities = useRemoteControlStore();
    const auth = useAuthStore();
    const discovered = capabilities.targets.find(item => item.deviceId === target.deviceId);
    if (!capabilities.canControl || !auth.token || auth.loggingOut || !discovered || !discovered.online || discovered.busy || !discovered.canHostView || (requestedScope === 'control' && !discovered.canHostControl)) throw new Error('当前设备暂不能发起远程协助');
    if (visible.value) throw new Error('请先结束当前远程协助');
    claim = mediaOccupancy.acquire('remote-control', `remote:${createRequestId()}`, reason => end(reason));
    if (!claim) throw new Error('请先结束当前通话或屏幕共享');
    const current = ++generation;
    device.value = { ...discovered };
    sessionId.value = null; stream.value = null; stats.value = null;
    inputArmed.value = false; needsApproval.value = false; textQueue.cancel(); scope.value = 'view';
    phase.value = 'requesting'; statusMessage.value = '正在请求对方确认';
    failureCode.value = '';
    events = Promise.resolve(); queuedEvents = queuedBytes = 0;
    deadline = setTimeout(() => end('REMOTE_REQUEST_TIMEOUT'), 45000);
    try {
      const platform = capabilities.capabilities?.runtime === 'tauri' ? capabilities.capabilities.native?.platform : 'web';
      if (platform !== 'web' && platform !== 'macos' && platform !== 'windows') throw new Error('当前平台不支持远程协助');
      adapter = new SocketRemoteControllerAdapter(auth.token, platform, event => queue(event, current));
      const id = await adapter.request(target.deviceId, requestedScope);
      if (current !== generation) return;
      sessionId.value = id;
      if (phase.value === 'requesting') phase.value = 'pending';
    } catch (error) {
      if (current === generation) end('REMOTE_REQUEST_FAILED');
      throw error;
    }
  }

  function queue(event: RemoteControllerEvent, current: number) {
    if (current !== generation) return;
    if (event.type === 'ended') { end(event.reason, false); return; }
    if (event.type === 'state') {
      if (event.value.state === 'ended') { end('REMOTE_SESSION_ENDED', false); return; }
      peer?.observeAuthorization(event.value.scope, event.value.authorizationRevision, event.value.controlEpoch);
      if (event.value.scope === 'view') { needsApproval.value = true; pauseInput('REMOTE_VIEW_ONLY'); }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    queuedEvents++; queuedBytes += bytes;
    if (queuedEvents > 140 || queuedBytes > 256 * 1024) { end('REMOTE_EVENT_LIMIT'); return; }
    events = events.then(async () => {
      if (current !== generation) return;
      queuedEvents--; queuedBytes -= bytes;
      await handleEvent(event, current);
    }).catch((error: unknown) => {
      if (current === generation) end(error instanceof Error && /^REMOTE_[A-Z_]{1,64}$/.test(error.message)
        ? error.message : 'REMOTE_PROTOCOL_FAILED');
    });
  }

  async function handleEvent(event: Exclude<RemoteControllerEvent, { type: 'ended' }>, current: number) {
    if (event.type === 'connecting') {
      if (peer) throw new Error('REMOTE_CONNECTING_REPLAY');
      phase.value = 'connecting'; statusMessage.value = '正在建立安全连接'; sessionId.value = event.value.sessionId;
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => end('REMOTE_CONNECT_TIMEOUT'), Math.min(30000, event.value.hardDeadline - Date.now()));
      const [ice, keyset] = await Promise.all([getRemoteSessionIce(event.value.sessionId), getRemoteSigningKeys()]);
      if (current !== generation) return;
      validateRemoteIceConfiguration(ice, event.value.hardDeadline);
      const { host, controller, consentNonce, screenId, negotiationId } = event.value;
      peer = new RemoteControlPeer({
        binding: { sessionId: event.value.sessionId, host, controller, consentNonce, screenId, negotiationId },
        iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy, keys: keyset.keys,
        onSignal: signal => adapter!.signal(signal),
        onReady: () => adapter!.ready({ negotiationId, hostFingerprint: sdpSha256Fingerprint(peer!.peer.remoteDescription!.sdp), controllerFingerprint: sdpSha256Fingerprint(peer!.peer.localDescription!.sdp) }),
        onStream: value => { if (current === generation) stream.value = value; },
        onAuthorization: value => { if (current === generation) { scope.value = value; needsApproval.value = value === 'view';
          if (phase.value !== 'active') { if (deadline) clearTimeout(deadline); deadline = setTimeout(() => end('REMOTE_SESSION_EXPIRED'), event.value.hardDeadline - Date.now()); }
          phase.value = 'active'; statusMessage.value = value === 'control' ? '已获控制许可，点击继续操作后开始' : '仅观看，尚未授予键鼠控制权限'; } },
        onPauseInput: reason => { if (current === generation) { textQueue.cancel(); inputArmed.value = false; if (reason === 'REMOTE_HOST_PAUSED') needsApproval.value = true; statusMessage.value = scope.value === 'control' ? '操作已暂停，确认画面正常后可继续' : '仅观看，尚未授予键鼠控制权限'; } },
        onInputArmed: value => { if (current === generation) { inputArmed.value = value; if (value) statusMessage.value = '正在操作对方电脑'; } },
        onInputWindow: () => { if (current === generation) textQueue.windowAvailable(event => !!peer?.sendInput(event)); },
        onEnd: reason => { if (current === generation) end(reason); },
        onStats: value => { if (current === generation) stats.value = value; },
      });
      if (videoElement) peer.attachVideo(videoElement);
      await peer.start();
    } else if (event.type === 'signal') {
      if (!peer) throw new Error('REMOTE_PEER_REQUIRED');
      await peer.receiveSignal(event.value);
    } else if (event.type === 'connection-proof') {
      if (!peer) throw new Error('REMOTE_PEER_REQUIRED');
      await peer.installConnectionProof(event.value);
    } else if (event.type === 'lease') {
      if (!peer) throw new Error('REMOTE_PEER_REQUIRED');
      await peer.installMediaLease(event.value);
    } else if (event.type === 'control-approved') {
      if (!peer?.approveBindingUpdate(event.value)) throw new Error('REMOTE_APPROVAL_INVALID');
    } else if (event.type === 'state') {
      peer?.observeAuthorization(event.value.scope, event.value.authorizationRevision, event.value.controlEpoch);
      if (event.value.state === 'ended') end('REMOTE_SESSION_ENDED', false);
      else if (event.value.scope === 'view') { needsApproval.value = true; pauseInput('REMOTE_VIEW_ONLY'); }
      // Socket state updates never authorize media or input.
    }
  }

  function attachVideo(video: HTMLVideoElement | null) { videoElement = video; peer?.attachVideo(video); }
  function mapPointer(clientX: number, clientY: number) { return peer?.mapPointer(clientX, clientY) ?? null; }
  function sendInput(event: RemoteInputEvent) { return !!peer?.sendInput(event); }
  function continueInput() {
    videoElement?.focus();
    const accepted = !!peer?.requestInputArm();
    if (!accepted) statusMessage.value = '暂时无法继续操作，请等待正常画面或对方重新授权';
    return accepted;
  }
  function pauseInput(reason = 'CONTROLLER_PAUSED') { textQueue.cancel(); inputArmed.value = false; peer?.pauseInput(reason); }
  async function commitText(text: string) {
    if (!text || [...text].length > 1024 || scope.value !== 'control') return false;
    videoElement?.focus();
    const current = generation;
    const sent = inputArmed.value
      ? !!peer?.sendInput({ type: 'text', payload: { text, commitId: createRequestId() } })
      : await textQueue.submit(text, continueInput);
    if (!sent && current === generation) statusMessage.value = '文字未发送，请在画面正常并获准操作后重新发送';
    return sent;
  }
  async function requestControl() {
    if (!adapter || phase.value !== 'active' || !device.value?.canHostControl) return;
    statusMessage.value = '等待对方重新确认控制许可';
    await adapter.requestControl();
  }
  function end(reason = 'REMOTE_LOCAL_END', notify = true) {
    if (!visible.value && !adapter && !peer) return;
    generation++;
    if (deadline) clearTimeout(deadline);
    deadline = null;
    const currentAdapter = adapter; adapter = null;
    const currentPeer = peer; peer = null;
    currentPeer?.end(reason);
    claim?.release(); claim = null;
    stream.value = null; stats.value = null; inputArmed.value = false; needsApproval.value = false; textQueue.cancel(); scope.value = 'view';
    phase.value = 'ended'; statusMessage.value = '远程协助已结束';
    failureCode.value = reason !== 'REMOTE_LOCAL_END' && /^REMOTE_[A-Z_]{1,64}$/.test(reason) ? reason : '';
    if (notify) void currentAdapter?.end(reason).catch(() => currentAdapter.dispose());
    else currentAdapter?.dispose();
  }
  registerRemoteControlCleanup(reason => end(reason));
  return { phase, device, sessionId, stream, stats, scope, inputArmed, needsApproval, statusMessage, failureCode, visible, start, attachVideo, mapPointer, sendInput, continueInput, commitText, requestControl, pauseInput, end };
});
