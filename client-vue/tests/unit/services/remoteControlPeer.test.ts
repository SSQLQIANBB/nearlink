import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteControlPeer, allowedRemoteVideoCodecs, type RemotePeerOptions } from '@/services/remoteControlPeer';
import type { RemoteControlLayout } from '@/services/remoteControlGeometry';

const certificate = new Uint8Array([1, 2, 3]).buffer;
const fingerprint = createHash('sha256').update(new Uint8Array(certificate)).digest('hex').toUpperCase();
const endpoint = { userId: 1, sid: 'sid', authVersion: 'version', endpointId: 'device', connectionId: 'socket', generation: 1 };
const binding = { sessionId: 'session', host: endpoint, controller: { ...endpoint, userId: 2 }, negotiationId: 'negotiation', consentNonce: 'nonce', screenId: 'primary' };
const envelope = { format: 'rc-signed-v1' as const, keyId: 'test', payload: 'payload', signature: 'signature' };
const layout = JSON.parse(readFileSync(resolve(process.cwd(), '../fixtures/remote-control-layout-v1.json'), 'utf8')).cases[0].layout as RemoteControlLayout;
class Channel {
  readyState = 'open'; bufferedAmount = 0;
  send = vi.fn((_data: string) => {});
  close = vi.fn();
  onmessage: ((event: { data: string }) => void) | null = null;
}
class Stream {
  tracks: MediaStreamTrack[] = [];
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  getVideoTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}
let peer: RemoteControlPeer;
let proofVerifier: Mock<NonNullable<RemotePeerOptions['verifyProof']>>;
let state: Channel;
let input: Channel;
let video: HTMLVideoElement;
let rendered: (() => void) | null;
let now: number;
let decodedSize: { width: number; height: number };
const onPause = vi.fn();
const onEnd = vi.fn();
const onArmed = vi.fn();
const messages = () => state.send.mock.calls.map(([value]) => JSON.parse(value));
function host(type: string, payload: object = {}) {
  state.onmessage?.({ data: JSON.stringify({ version: 1, sessionId: binding.sessionId, negotiationId: binding.negotiationId, connectionGeneration: 1, type, payload }) });
}
function render() { const callback = rendered; rendered = null; callback?.(); }
function acceptArm() {
  const request = messages().find(message => message.type === 'input-arm').payload;
  const context = { ...request, sessionId: binding.sessionId, inputEpoch: 1 };
  host('input-armed', context);
  host('input-window', { ...context, inputWindowId: 'ticket' });
}
async function setup(sendLayout = true, completeHandshake = true) {
  vi.useFakeTimers(); vi.clearAllMocks(); now = 0; rendered = null;
  decodedSize = { width: 1280, height: 720 };
  let leaseSeq = 0;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' }] }) });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  state = new Channel(); input = new Channel();
  const rtc = {
    addTransceiver: () => ({ setCodecPreferences: vi.fn() }),
    createDataChannel: (label: string) => label === 'rc-state-v1' ? state : input,
    sctp: { transport: { state: 'connected', getRemoteCertificates: () => [certificate] } },
    localDescription: { sdp: `a=fingerprint:sha-256 ${fingerprint}\r\n` },
    remoteDescription: { sdp: `a=fingerprint:sha-256 ${fingerprint}\r\n` },
    close: vi.fn(),
    ontrack: null as ((event: { track: object }) => void) | null,
  };
  const verifyProof: RemotePeerOptions['verifyProof'] = async (_proof, _keys, _binding, purpose) => ({
    envelope, deadline: 15000,
    claims: { ...binding, hostFingerprint: fingerprint, controllerFingerprint: fingerprint, protocolVersion: 1, issuer: 'todesk-remote-control', audience: 'todesk-remote-peer', purpose, scope: 'control', authorizationRevision: 1, controlEpoch: 1, issuedAt: 0, expiresAt: 15000, ...(purpose === 'lease' ? { leaseSeq: ++leaseSeq, challenge: 'challenge' } : {}) },
  });
  proofVerifier = vi.fn(verifyProof);
  peer = new RemoteControlPeer({ binding, iceServers: [], iceTransportPolicy: 'all', keys: [], onSignal: vi.fn(), onReady: vi.fn(), onStream: vi.fn(), onPauseInput: onPause, onEnd, onInputArmed: onArmed, now: () => now, createPeer: () => rtc as unknown as RTCPeerConnection, verifyProof: proofVerifier });
  video = document.createElement('video'); video.tabIndex = 0; document.body.append(video); video.focus();
  vi.spyOn(video, 'videoWidth', 'get').mockImplementation(() => decodedSize.width);
  vi.spyOn(video, 'videoHeight', 'get').mockImplementation(() => decodedSize.height);
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 1000, height: 1000 } as DOMRect);
  video.play = vi.fn().mockResolvedValue(undefined);
  video.requestVideoFrameCallback = vi.fn(callback => { rendered = () => callback(now, {} as VideoFrameCallbackMetadata); return 1; });
  video.cancelVideoFrameCallback = vi.fn();
  peer.attachVideo(video);
  rtc.ontrack?.({ track: { kind: 'video', stop: vi.fn(), onended: null } });
  await peer.installConnectionProof(envelope);
  if (!completeHandshake) return;
  host('hello', { proofSignature: envelope.signature });
  await peer.installMediaLease(envelope);
  if (sendLayout) host('layout', layout);
  state.send.mockClear();
}
beforeEach(() => setup());
afterEach(() => { peer.end('TEST_CLEANUP'); video.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('主控启用输入前报告真实渲染进度', () => {
  it('offers only the released native H264 format even when VP8 is preferred by the browser', () => {
    const supported = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1; packetization-mode=1; profile-level-id=42e01f' };
    const incompatible = [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { ...supported, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
      { ...supported, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640c1f' },
      { ...supported, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e034' },
    ];
    expect(allowedRemoteVideoCodecs([...incompatible, supported])).toEqual([supported]);
    expect(allowedRemoteVideoCodecs(incompatible)).toEqual([]);
  });
  it('时间校验失败只等待一次，并用新时钟重新严格验签', async () => {
    proofVerifier.mockClear(); proofVerifier.mockRejectedValueOnce(new Error('REMOTE_PROOF_EXPIRED'));
    const before = Date.now();
    const pending = peer.installMediaLease(envelope);
    await vi.advanceTimersByTimeAsync(249);
    expect(proofVerifier).toHaveBeenCalledTimes(1);
    now = 250; await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(proofVerifier).toHaveBeenCalledTimes(2);
    expect(proofVerifier.mock.calls[1]![4]).toEqual({ wall: before + 250, monotonic: 250 });
  });
  it('等待不会让真正过期的凭据通过', async () => {
    proofVerifier.mockClear(); proofVerifier.mockRejectedValue(new Error('REMOTE_PROOF_EXPIRED'));
    const rejected = expect(peer.installMediaLease(envelope)).rejects.toThrow('REMOTE_PROOF_EXPIRED');
    await vi.advanceTimersByTimeAsync(250); await rejected;
    expect(proofVerifier).toHaveBeenCalledTimes(2);
  });
  it('等待期间结束会话不会再次验签或恢复连接', async () => {
    proofVerifier.mockClear(); proofVerifier.mockRejectedValueOnce(new Error('REMOTE_PROOF_EXPIRED'));
    const rejected = expect(peer.installMediaLease(envelope)).rejects.toThrow('REMOTE_SESSION_ENDED');
    await vi.advanceTimersByTimeAsync(1); peer.end('REMOTE_LOCAL_END');
    await vi.advanceTimersByTimeAsync(249); await rejected;
    expect(proofVerifier).toHaveBeenCalledTimes(1);
  });

  it('握手确认前不发送周期心跳，确认后才开始发送', async () => {
    peer.end('RECREATE'); video.remove(); await setup(false, false);
    expect(messages().map(message => message.type)).toEqual(['hello']);
    now = 1500; await vi.advanceTimersByTimeAsync(1500);
    expect(messages().map(message => message.type)).toEqual(['hello']);
    expect(onEnd).not.toHaveBeenCalled();
    host('hello', { proofSignature: envelope.signature });
    now = 1600; await vi.advanceTimersByTimeAsync(100);
    expect(messages().map(message => message.type)).toEqual(['hello', 'heartbeat']);
  });
  it('握手前使用连接截止时间，不把正常的 TURN 协商误判为心跳丢失', async () => {
    peer.end('RECREATE'); video.remove(); await setup(false, false);
    now = 3000; await vi.advanceTimersByTimeAsync(3000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(messages().some(message => message.type === 'heartbeat')).toBe(false);
    now = 30000; await vi.advanceTimersByTimeAsync(100);
    expect(onEnd).toHaveBeenCalledWith('REMOTE_CONNECT_TIMEOUT');
  });
  it('握手完成后仍严格执行三秒心跳期限', async () => {
    now = 3000; await vi.advanceTimersByTimeAsync(3000);
    expect(onEnd).toHaveBeenCalledWith('REMOTE_HEARTBEAT_TIMEOUT');
  });
  it('首帧之后在同一通道先报告渲染计数再请求启用，仍须宿主窗口才可输入', async () => {
    render();
    expect(peer.requestInputArm()).toBe(true);
    expect(messages().map(message => message.type)).toEqual(['heartbeat', 'input-arm']);
    expect(messages()[0].payload).toEqual({ renderedFrames: 1 });
    expect(peer.input.armed).toBe(false);
    now = 100; await vi.advanceTimersByTimeAsync(100);
    expect(messages()).toHaveLength(2); // Explicit progress report replaces this periodic heartbeat.
    acceptArm();
    expect(peer.input.armed).toBe(true);
  });
  it('没有渲染帧时不发送心跳授权暗示或启用请求', () => {
    expect(peer.requestInputArm()).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
    expect(peer.input.armed).toBe(false);
  });
  it.each(['closed', 'heartbeat-failed', 'arm-failed'] as const)('%s 时请求失败且不保留可接受的启用请求', failure => {
    render();
    if (failure === 'closed') state.readyState = 'closed';
    else if (failure === 'heartbeat-failed') state.send.mockImplementationOnce(() => { throw new Error('closed'); });
    else state.send.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('closed'); });
    expect(peer.requestInputArm()).toBe(false);
    expect(peer.input.armed).toBe(false);
    if (failure !== 'arm-failed') expect(messages().some(message => message.type === 'input-arm')).toBe(false);
    else {
      acceptArm(); // A late response to a failed send cannot reopen input.
      expect(peer.input.armed).toBe(false);
    }
  });
  it('宿主因画面冻结暂停后，新帧与续租均不能自动恢复旧控制授权', async () => {
    render(); peer.requestInputArm(); acceptArm();
    host('pause', { reason: 'REMOTE_CAPTURE_STALLED' });
    expect(peer.input.armed).toBe(false);
    expect(onPause).toHaveBeenCalledWith('REMOTE_HOST_PAUSED');
    now = 100; render(); state.send.mockClear();
    await peer.installMediaLease(envelope);
    expect(peer.requestInputArm()).toBe(false);
    expect(peer.sendInput({ type: 'key', payload: { code: 'KeyA', down: true } })).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
  it('尚未启用输入时收到宿主暂停仍通知界面请求新许可', () => {
    render();
    host('pause', { reason: 'REMOTE_CAPTURE_STALLED' });
    expect(onPause).toHaveBeenCalledExactlyOnceWith('REMOTE_HOST_PAUSED');
    expect(peer.requestInputArm()).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
});

describe('布局和解码尺寸绑定', () => {
  it('未收到geometry即使已经出帧也不能请求启用，收到布局后才允许', async () => {
    peer.end('RECREATE'); video.remove(); await setup(false); render();
    expect(peer.requestInputArm()).toBe(false); expect(peer.mapPointer(510, 520)).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    host('layout', layout);
    expect(peer.requestInputArm()).toBe(true);
  });
  it('尚无解码尺寸不能启用，首帧尺寸有效后可以显式请求', () => {
    decodedSize = { width: 0, height: 0 }; render();
    expect(peer.requestInputArm()).toBe(false); expect(onEnd).not.toHaveBeenCalled();
    decodedSize = { width: 1280, height: 720 }; render();
    expect(peer.requestInputArm()).toBe(true);
  });
  it('peer映射统一拒绝两层黑边，返回内容归一化坐标', () => {
    expect(peer.mapPointer(510, 520)).toEqual({ x: 0.5, y: 0.5 });
    expect(peer.mapPointer(60, 238.75)).toEqual({ x: 0, y: 0 });
    expect(peer.mapPointer(20, 520)).toBeNull();
    expect(peer.mapPointer(510, 21)).toBeNull();
  });
  it.each([
    ['版本', (value: RemoteControlLayout) => { value.layoutVersion++; }],
    ['同版本内容区', (value: RemoteControlLayout) => { value.geometry.contentRect.x++; }],
    ['同版本DPI', (value: RemoteControlLayout) => { value.geometry.displayPixels.width++; }],
    ['同版本旋转', (value: RemoteControlLayout) => { value.geometry.rotationDegrees = 90; }],
    ['同版本桌面原点', (value: RemoteControlLayout) => { value.geometry.displayBounds.x--; }],
  ] as const)('%s变更立即释放并结束', (_name, change) => {
    render(); peer.requestInputArm(); acceptArm();
    const changed = structuredClone(layout); change(changed); host('layout', changed);
    expect(peer.input.armed).toBe(false); expect(onEnd).toHaveBeenCalledWith('REMOTE_LAYOUT_CHANGED');
  });
  it('完全相同的重复布局不停止；未知字段拒绝', () => {
    host('layout', { geometry: layout.geometry, layoutVersion: 1, screenId: 'primary' });
    expect(onEnd).not.toHaveBeenCalled();
    host('layout', { ...layout, extra: true });
    expect(onEnd).toHaveBeenCalledWith('REMOTE_LAYOUT_INVALID');
  });
  it('旧版只有layoutVersion的消息不能授权输入', () => {
    host('layout', { screenId: 'primary', layoutVersion: 1 });
    expect(onEnd).toHaveBeenCalledWith('REMOTE_LAYOUT_INVALID');
    expect(peer.requestInputArm()).toBe(false);
  });
  it.each(['resize', 'input', 'queued-move'] as const)('%s发现解码尺寸变化，停止并且不发送旧坐标', async path => {
    render(); peer.requestInputArm(); acceptArm();
    if (path === 'queued-move') {
      peer.sendInput({ type: 'move', payload: { x: 0.1, y: 0.1 } });
      now = 1; peer.sendInput({ type: 'move', payload: { x: 0.2, y: 0.2 } });
    }
    input.send.mockClear(); decodedSize.width = 640;
    if (path === 'resize') video.dispatchEvent(new Event('resize'));
    else if (path === 'input') expect(peer.sendInput({ type: 'key', payload: { code: 'KeyA', down: true } })).toBe(false);
    else { now = 40; await vi.advanceTimersByTimeAsync(50); }
    expect(input.send).not.toHaveBeenCalled(); expect(peer.input.armed).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('REMOTE_VIDEO_GEOMETRY_MISMATCH');
  });
});
