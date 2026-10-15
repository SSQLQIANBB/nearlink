import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  emit: vi.fn(),
  replace: vi.fn(),
  peers: [] as any[],
  captured: null as any,
  getUserMedia: vi.fn(),
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '7' }, name: 'GroupVideo' }),
  useRouter: () => ({ replace: mock.replace, back: vi.fn() }),
}));
vi.mock('naive-ui', () => ({
  useMessage: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/api/auth', () => ({
  getUserList: async () => ({ users: [{ id: 2, username: 'peer' }] }),
}));
vi.mock('@/api/group', () => ({
  getGroupDetail: async () => ({
    group: { id: 7, name: '测试群' },
    members: [
      { id: 1, role: 'owner', canSpeak: true },
      { id: 2, username: 'peer' },
    ],
  }),
}));
vi.mock('@/stores/auth', async () => {
  const { defineStore } = await import('pinia');
  const { ref } = await import('vue');
  return {
    useAuthStore: defineStore('test-auth', () => ({ currentUser: ref({ id: 1, username: 'me' }) })),
  };
});
vi.mock('@/stores/socket', async () => {
  const { defineStore } = await import('pinia');
  const { shallowRef, ref } = await import('vue');
  return {
    useSocketStore: defineStore('test-socket', () => ({
      authenticated: ref(true),
      socket: shallowRef({
        id: 'self',
        emit: mock.emit,
        on: (event: string, callback: Function) => mock.handlers.set(event, callback),
        off: (event: string) => mock.handlers.delete(event),
      }),
      joinGroup: vi.fn(),
      leaveGroup: vi.fn(),
    })),
  };
});
vi.mock('@/services/screenShareLaunch', () => ({ takeCapturedGroupScreen: () => mock.captured }));
vi.mock('@/services/mediaBitrate', () => ({ limitVideoBitrate: vi.fn() }));
vi.mock('@/components/VirtualBackground.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MediaRecorder.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MediaVideo.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/SpeakingIndicator.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/ScreenAnnotation.vue', () => ({ default: { template: '<div />' } }));
import GroupVideo from '../../../src/views/groupVideo.vue';
import GroupScreen from '../../../src/features/screenShare/ScreenShare.vue';
import { groupSessionState } from '../../../src/services/groupSessionState';

class Stream {
  constructor(private tracks: any[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
class Peer {
  close = vi.fn();
  senders: any[] = [];
  getSenders = () => this.senders;
  addTrack = vi.fn((track) => {
    const sender = {
      track,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async () => undefined),
    };
    this.senders.push(sender);
    return sender;
  });
  addTransceiver = vi.fn(() => ({}));
  addIceCandidate = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  setLocalDescription = vi.fn(async () => undefined);
  createAnswer = vi.fn(async () => ({}));
  createOffer = vi.fn(async () => ({}));
  signalingState = 'stable';
  constructor() {
    mock.peers.push(this);
  }
}
const session = {
  groupId: 7,
  type: 'screen' as const,
  channelId: 'group:7:screen',
  ownerUserId: 1,
  ownerSocketId: 'self',
  startedAt: '2026-09-28T10:00:00.000Z',
};
let wrapper: VueWrapper | undefined;
let audio: { kind: string; stop: ReturnType<typeof vi.fn>; enabled: boolean };
let video: {
  kind: string;
  stop: ReturnType<typeof vi.fn>;
  enabled: boolean;
  applyConstraints: ReturnType<typeof vi.fn>;
  getConstraints: () => MediaTrackConstraints;
};
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.peers.length = 0;
  groupSessionState.clearGroup(7);
  audio = { kind: 'audio', stop: vi.fn(), enabled: true };
  video = {
    kind: 'video',
    stop: vi.fn(),
    enabled: true,
    applyConstraints: vi.fn(async () => undefined),
    getConstraints: () => ({}),
  };
  mock.getUserMedia.mockResolvedValue(new Stream([audio, video]));
  mock.captured = null;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mock.getUserMedia },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('RTCPeerConnection', Peer);
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

async function open(kind: 'video' | 'screen') {
  if (kind === 'screen') {
    mock.captured = new Stream([video]);
    groupSessionState.applyStarted(session);
  }
  wrapper = shallowMount(kind === 'video' ? GroupVideo : GroupScreen, {
    props: kind === 'screen' ? { scope: { kind: 'group' as const, id: 7 } } : {},
    global: { config: { warnHandler: () => undefined } },
  });
  await flushPromises();
  const active = { ...session, type: kind, channelId: `group:7:${kind}` };
  mock.handlers.get('group_call_state')!({ groupId: 7, sessions: { [kind]: active } });
  await mock.handlers.get('group_call_members')!({
    groupId: 7,
    type: kind,
    startedAt: session.startedAt,
    members: [{ id: 2, username: 'peer', socketId: 'peer' }],
  });
  await flushPromises();
  return kind === 'video' ? 1 : 2;
}
describe.each(['video', 'screen'] as const)('%s 页面授权撤销', (kind) => {
  it.each(['group_access_revoked', 'group_call_error', 'disconnect'])(
    '%s 停止本地轨道、关闭已有P2P且不再自动重连',
    async (event) => {
      await open(kind);
      expect(mock.peers.length).toBeGreaterThan(0);
      mock.handlers.get(event)!({ groupId: 7, message: '权限失效' });
      await flushPromises();
      expect(audio.stop).toHaveBeenCalled();
      expect(video.stop).toHaveBeenCalled();
      expect(mock.peers.every((peer) => peer.close.mock.calls.length > 0)).toBe(true);
      expect(mock.replace).toHaveBeenCalledWith(kind === 'screen' ? '/group-chat/7' : '/groups');
      expect(mock.handlers.has('group_webrtc_offer')).toBe(false);
      expect(mock.handlers.has('group_call_state')).toBe(false);
    },
  );
  it('其它群的撤销不影响当前会话，旧会话信令不会创建新Peer', async () => {
    const deviceType = await open(kind);
    mock.handlers.get('group_access_revoked')!({ groupId: 8 });
    expect(audio.stop).not.toHaveBeenCalled();
    const count = mock.peers.length;
    await mock.handlers.get('group_webrtc_offer')!({
      groupId: 7,
      deviceType,
      startedAt: 'old',
      from: 'old-peer',
      fromUser: { id: 3 },
      offer: {},
    });
    expect(mock.peers).toHaveLength(count);
    const join = mock.emit.mock.calls.find(([event, data]) =>
      kind === 'video'
        ? event === 'join_group_call'
        : event === 'screen_share' && data.action === 'join',
    );
    expect(kind === 'video' ? join?.[1] : join?.[1].payload).toMatchObject({
      groupId: 7,
      startedAt: session.startedAt,
    });
  });
});

describe('屏幕共享资源释放', () => {
  it('加入与发起共享并发时，退出停止所有申请过的麦克风', async () => {
    const microphones: any[] = [];
    mock.getUserMedia.mockImplementation(async () => {
      const track = { kind: 'audio', stop: vi.fn(), enabled: true };
      microphones.push(track);
      return new Stream([track]);
    });
    await open('screen');
    (wrapper!.vm as any).$.setupState.handleExit();
    expect(mock.getUserMedia).toHaveBeenCalledTimes(1);
    expect(microphones.length).toBeGreaterThan(0);
    expect(microphones.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(video.stop).toHaveBeenCalled();
  });
});

it('退出时立即停止屏幕，并释放随后授权成功的麦克风', async () => {
  let resolveAudio!: (stream: Stream) => void;
  mock.getUserMedia.mockImplementation(
    () =>
      new Promise<Stream>((resolve) => {
        resolveAudio = resolve;
      }),
  );
  await open('screen');
  (wrapper!.vm as any).$.setupState.handleExit();
  expect(video.stop).toHaveBeenCalled();
  mock.emit.mockClear();
  resolveAudio(new Stream([audio]));
  await flushPromises();
  expect(audio.stop).toHaveBeenCalled();
  expect(mock.emit).not.toHaveBeenCalledWith('group_call_start', expect.anything());
  expect(mock.emit).not.toHaveBeenCalledWith('join_group_call', expect.anything());
  expect(
    mock.emit.mock.calls.some(
      ([event, data]) => event === 'screen_share' && ['start', 'join'].includes(data.action),
    ),
  ).toBe(false);
});

it('个人会话复用共享组件的采集、标注、成员和退出链路', async () => {
  mock.captured = new Stream([video]);
  wrapper = shallowMount(GroupScreen, {
    props: { scope: { kind: 'private', peerId: 2 } },
    global: { config: { warnHandler: () => undefined } },
  });
  await flushPromises();
  expect(mock.emit).toHaveBeenCalledWith(
    'screen_share',
    expect.objectContaining({
      scope: { kind: 'private', peerId: 2 },
      action: 'start',
    }),
  );
  const privateSession = {
    ...session,
    groupId: 'private:1:2',
    channelId: 'group:private:1:2:screen',
  };
  mock.handlers.get('group_call_state')!({
    groupId: 'private:1:2',
    sessions: { screen: privateSession },
  });
  await flushPromises();
  mock.handlers.get('group_call_members')!({
    ...privateSession,
    members: [{ id: 2, username: 'peer', socketId: 'peer' }],
  });
  await flushPromises();
  expect(mock.peers).toHaveLength(1);
  const state = (wrapper.vm as any).$.setupState;
  state.sendAnnotationClear();
  expect(mock.emit).toHaveBeenCalledWith(
    'screen_share',
    expect.objectContaining({
      scope: { kind: 'private', peerId: 2 },
      action: 'clear',
      payload: expect.objectContaining({ startedAt: session.startedAt }),
    }),
  );
  state.handleExit();
  expect(mock.peers[0].close).toHaveBeenCalled();
  expect(video.stop).toHaveBeenCalled();
  expect(audio.stop).toHaveBeenCalled();
  expect(mock.emit).toHaveBeenCalledWith(
    'screen_share',
    expect.objectContaining({ action: 'end' }),
  );
});

it('共享连接先缓存早于 SDP 的 ICE，协商后再应用', async () => {
  await open('screen');
  const candidate = { candidate: 'candidate:early' };
  await mock.handlers.get('group_webrtc_ice')!({
    groupId: 7,
    deviceType: 2,
    startedAt: session.startedAt,
    from: 'peer',
    candidate,
  });
  expect(mock.peers[0].addIceCandidate).not.toHaveBeenCalled();
  await mock.handlers.get('group_webrtc_answer')!({
    groupId: 7,
    deviceType: 2,
    startedAt: session.startedAt,
    from: 'peer',
    answer: {},
  });
  expect(mock.peers[0].addIceCandidate).toHaveBeenCalledWith(candidate);
});

it('切换清晰度保留共享、麦克风、轨道和接收方连接', async () => {
  await open('screen');
  const state = (wrapper!.vm as any).$.setupState;
  mock.emit.mockClear();
  const microphoneRequests = mock.getUserMedia.mock.calls.length;
  const peer = mock.peers[0];
  await state.handleQualityChange('ultra');
  expect(video.applyConstraints).toHaveBeenCalledWith({
    width: { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 30, max: 30 },
  });
  expect(
    peer.getSenders().find((sender: any) => sender.track.kind === 'video').setParameters,
  ).toHaveBeenLastCalledWith(
    expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 12_000_000 })] }),
  );
  expect(state.currentQuality).toBe('ultra');
  expect(state.isSharing).toBe(true);
  expect(mock.emit).not.toHaveBeenCalled();
  expect(mock.getUserMedia).toHaveBeenCalledTimes(microphoneRequests);
  expect(peer.close).not.toHaveBeenCalled();
  expect(video.stop).not.toHaveBeenCalled();
  expect(audio.stop).not.toHaveBeenCalled();
});
it('清晰度切换失败不结束共享或报告已切换', async () => {
  await open('screen');
  const state = (wrapper!.vm as any).$.setupState;
  video.applyConstraints.mockRejectedValueOnce(new Error('unsupported'));
  mock.emit.mockClear();
  await state.handleQualityChange('ultra');
  expect(state.currentQuality).toBe('high');
  expect(state.isSharing).toBe(true);
  expect(video.stop).not.toHaveBeenCalled();
  expect(mock.emit).not.toHaveBeenCalled();
});
it('切换期间退出不继续修改发送端或更新质量状态', async () => {
  await open('screen');
  const state = (wrapper!.vm as any).$.setupState;
  let resolve!: () => void;
  video.applyConstraints.mockReturnValueOnce(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const pending = state.handleQualityChange('ultra');
  await state.handleQualityChange('low');
  expect(video.applyConstraints).toHaveBeenCalledTimes(1);
  state.handleExit();
  resolve();
  await pending;
  expect(state.currentQuality).toBe('high');
});

it('发送端拒绝新参数时恢复采集和编码，不结束会话', async () => {
  await open('screen');
  const state = (wrapper!.vm as any).$.setupState;
  const sender = mock.peers[0].getSenders().find((sender: any) => sender.track.kind === 'video');
  sender.setParameters.mockRejectedValueOnce(new Error('encoding rejected'));
  mock.emit.mockClear();
  await state.handleQualityChange('ultra');
  expect(state.currentQuality).toBe('high');
  expect(video.applyConstraints).toHaveBeenLastCalledWith({});
  expect(sender.setParameters).toHaveBeenLastCalledWith(
    expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 8_000_000 })] }),
  );
  expect(mock.emit).not.toHaveBeenCalled();
  expect(mock.peers[0].close).not.toHaveBeenCalled();
});
