import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Function>(), emit: vi.fn(), replace: vi.fn(), peers: [] as any[],
  captured: null as any, getUserMedia: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: '7' }, name: 'GroupVideo' }), useRouter: () => ({ replace: mock.replace, back: vi.fn() }) }));
vi.mock('naive-ui', () => ({ useMessage: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
vi.mock('@/api/group', () => ({ getGroupDetail: async () => ({ group: { id: 7, name: '测试群' }, members: [{ id: 1, role: 'owner', canSpeak: true }, { id: 2, username: 'peer' }] }) }));
vi.mock('@/stores/auth', async () => {
  const { defineStore } = await import('pinia'); const { ref } = await import('vue');
  return { useAuthStore: defineStore('test-auth', () => ({ currentUser: ref({ id: 1, username: 'me' }) })) };
});
vi.mock('@/stores/socket', async () => {
  const { defineStore } = await import('pinia'); const { shallowRef, ref } = await import('vue');
  return { useSocketStore: defineStore('test-socket', () => ({ authenticated: ref(true), socket: shallowRef({
    id: 'self', emit: mock.emit, on: (event: string, callback: Function) => mock.handlers.set(event, callback),
    off: (event: string) => mock.handlers.delete(event),
  }), joinGroup: vi.fn(), leaveGroup: vi.fn() })) };
});
vi.mock('@/services/screenShareLaunch', () => ({ takeCapturedGroupScreen: () => mock.captured }));
vi.mock('@/services/mediaBitrate', () => ({ limitVideoBitrate: vi.fn() }));
vi.mock('@/components/VirtualBackground.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MediaRecorder.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MediaVideo.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/SpeakingIndicator.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/ScreenAnnotation.vue', () => ({ default: { template: '<div />' } }));
import GroupVideo from '../../../src/views/groupVideo.vue';
import GroupScreen from '../../../src/views/groupScreen.vue';
import { groupSessionState } from '../../../src/services/groupSessionState';

class Stream {
  constructor(private tracks: any[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
class Peer {
  close = vi.fn(); addTrack = vi.fn(() => ({}));
  setRemoteDescription = vi.fn(async () => undefined); setLocalDescription = vi.fn(async () => undefined);
  createAnswer = vi.fn(async () => ({})); createOffer = vi.fn(async () => ({}));
  signalingState = 'stable';
  constructor() { mock.peers.push(this); }
}
const session = { groupId: 7, type: 'screen' as const, channelId: 'group:7:screen', ownerUserId: 1, ownerSocketId: 'self', startedAt: '2026-09-28T10:00:00.000Z' };
let wrapper: VueWrapper | undefined;
let audio: { kind: string; stop: ReturnType<typeof vi.fn>; enabled: boolean };
let video: { kind: string; stop: ReturnType<typeof vi.fn>; enabled: boolean };
beforeEach(() => {
  setActivePinia(createPinia()); vi.clearAllMocks(); mock.handlers.clear(); mock.peers.length = 0;
  groupSessionState.clearGroup(7);
  audio = { kind: 'audio', stop: vi.fn(), enabled: true };
  video = { kind: 'video', stop: vi.fn(), enabled: true };
  mock.getUserMedia.mockResolvedValue(new Stream([audio, video]));
  mock.captured = null;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: mock.getUserMedia } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('RTCPeerConnection', Peer);
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });

async function open(kind: 'video' | 'screen') {
  if (kind === 'screen') {
    mock.captured = new Stream([video]);
    groupSessionState.applyStarted(session);
  }
  wrapper = shallowMount(kind === 'video' ? GroupVideo : GroupScreen, { global: { config: { warnHandler: () => undefined } } });
  await flushPromises();
  const active = { ...session, type: kind, channelId: `group:7:${kind}` };
  if (kind === 'video') mock.handlers.get('group_call_state')!({ groupId: 7, sessions: { video: active } });
  await mock.handlers.get('group_call_members')!({ groupId: 7, type: kind, startedAt: session.startedAt,
    members: [{ id: 2, username: 'peer', socketId: 'peer' }] });
  await flushPromises();
  return kind === 'video' ? 1 : 2;
}
describe.each(['video', 'screen'] as const)('%s 页面授权撤销', kind => {
  it.each(['group_access_revoked', 'group_call_error', 'disconnect'])('%s 停止本地轨道、关闭已有P2P且不再自动重连', async event => {
    await open(kind);
    expect(mock.peers.length).toBeGreaterThan(0);
    mock.handlers.get(event)!({ groupId: 7, message: '权限失效' });
    await flushPromises();
    expect(audio.stop).toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
    expect(mock.peers.every(peer => peer.close.mock.calls.length > 0)).toBe(true);
    expect(mock.replace).toHaveBeenCalledWith('/groups');
    expect(mock.handlers.has('group_webrtc_offer')).toBe(false);
    expect(mock.handlers.has('group_call_state')).toBe(false);
  });
  it('其它群的撤销不影响当前会话，旧会话信令不会创建新Peer', async () => {
    const deviceType = await open(kind);
    mock.handlers.get('group_access_revoked')!({ groupId: 8 });
    expect(audio.stop).not.toHaveBeenCalled();
    const count = mock.peers.length;
    await mock.handlers.get('group_webrtc_offer')!({ groupId: 7, deviceType, startedAt: 'old', from: 'old-peer', fromUser: { id: 3 }, offer: {} });
    expect(mock.peers).toHaveLength(count);
    const join = mock.emit.mock.calls.find(([event]) => event === 'join_group_call');
    expect(join?.[1]).toMatchObject({ groupId: 7, startedAt: session.startedAt });
  });
});
