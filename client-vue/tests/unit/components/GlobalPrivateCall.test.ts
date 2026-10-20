import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { usePrivateCallStore } from '@/stores/privateCall';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  emit: vi.fn(),
  getUserMedia: vi.fn(),
  getDisplayMedia: vi.fn(),
  close: vi.fn(),
  stop: vi.fn(),
  peerInstance: null as any,
  audioTrack: { enabled: true, stop: vi.fn() },
  videoTrack: { enabled: true, stop: vi.fn() },
  startRingtone: vi.fn(),
  stopRingtone: vi.fn(),
}));
vi.mock('@/stores/socket', () => ({
  useSocketStore: () => ({
    userList: [],
    socket: {
      on: (event: string, handler: Function) => mocks.handlers.set(event, handler),
      off: (event: string) => mocks.handlers.delete(event),
      emit: mocks.emit,
    },
  }),
}));
vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/services/notificationService', () => ({
  default: {
    startOutgoingRingtone: vi.fn(),
    stopOutgoingRingtone: vi.fn(),
    getSoundPreferences: () => ({ callTone: 'default' }),
    showCall: vi.fn(),
    startCallRingtone: mocks.startRingtone,
    stopCallRingtone: mocks.stopRingtone,
  },
}));
import GlobalPrivateCall from '../../../src/components/GlobalPrivateCall.vue';
const Modal = defineComponent({
  name: 'NModal',
  props: ['show'],
  emits: ['positive-click', 'negative-click', 'close'],
  template: '<div v-if="show"><slot /></div>',
});
function render() {
  return mount(GlobalPrivateCall, {
    global: {
      stubs: { DialogSurface: Modal, Modal: Modal, NModal: Modal, NIcon: true, NSpin: true },
    },
  });
}
function request(type: number) {
  mocks.handlers.get('webrtc_call_request')!({
    from: 'alice',
    deviceType: type,
    user: { id: 1, nickname: 'Alice' },
  });
}
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.audioTrack.enabled = true;
  mocks.videoTrack.enabled = true;
  mocks.audioTrack.stop = mocks.stop;
  mocks.videoTrack.stop = mocks.stop;
  const stream = {
    getTracks: () => [mocks.videoTrack, mocks.audioTrack],
    getVideoTracks: () => [mocks.videoTrack],
    getAudioTracks: () => [mocks.audioTrack],
  };
  mocks.getUserMedia.mockResolvedValue(stream);
  mocks.getDisplayMedia.mockResolvedValue(stream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: mocks.getUserMedia,
      getDisplayMedia: mocks.getDisplayMedia,
    },
  });
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        mocks.peerInstance = this;
      }
      close = mocks.close;
      addTrack = vi.fn();
      addTransceiver = vi.fn();
      createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'recvonly' });
      setLocalDescription = vi.fn().mockResolvedValue(undefined);
    },
  );
});

describe('全局单人邀请（无需挂载聊天页或选择联系人）', () => {
  it('语音通话仅在底部显示挂断和静音图标，操作控制真实轨道', async () => {
    const wrapper = render();
    request(2);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    expect(wrapper.find('.private-call__header').exists()).toBe(false);
    expect(wrapper.find('.private-call__controls').exists()).toBe(false);
    const mute = wrapper.find('.audio-action--mute');
    expect(mute.text()).toBe('');
    await mute.trigger('click');
    expect(mocks.audioTrack.enabled).toBe(false);
    expect(mute.attributes('aria-pressed')).toBe('true');
    expect(mute.find('.icon-microphone-off').exists()).toBe(true);
    await mute.trigger('click');
    expect(mocks.audioTrack.enabled).toBe(true);
    await wrapper.find('.audio-action--hangup').trigger('click');
    expect(wrapper.find('.private-call').exists()).toBe(false);
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_hangup', expect.anything());
    wrapper.unmount();
  });
  it('视频接听后默认全屏，可缩成浮窗再恢复', async () => {
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    expect(wrapper.find('.private-call').exists()).toBe(true);
    expect(wrapper.find('.private-call__header').exists()).toBe(false);
    expect(wrapper.find('.private-call__controls').exists()).toBe(false);
    expect(wrapper.find('.private-call__video-actions').text()).toBe('');
    expect(wrapper.find('.private-call--compact').exists()).toBe(false);
    await wrapper.find('.private-call__fullscreen').trigger('click');
    expect(wrapper.find('.private-call--compact').exists()).toBe(true);
    await wrapper.find('.private-call__fullscreen').trigger('click');
    expect(wrapper.find('.private-call--compact').exists()).toBe(false);
    wrapper.unmount();
  });

  it('本地画面挂载后可见，点击小画面交换大小画面并保持远端声音', async () => {
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    const local = await mocks.getUserMedia.mock.results[0]!.value;
    const remote = {
      getTracks: () => [mocks.videoTrack],
      getVideoTracks: () => [mocks.videoTrack],
    };
    const main = wrapper.find('.private-call__remote video').element as HTMLVideoElement;
    const small = wrapper.find('.private-call__self video').element as HTMLVideoElement;
    expect(small.srcObject).toBe(local);
    mocks.peerInstance.ontrack({ streams: [remote] });
    expect(main.srcObject).toBe(remote);
    await wrapper.find('.private-call__self').trigger('click');
    await nextTick();
    expect(main.srcObject).toBe(local);
    expect(main.muted).toBe(true);
    expect(small.srcObject).toBe(remote);
    expect(small.muted).toBe(false);
    wrapper.unmount();
  });

  it('静音和关闭摄像头会切换实际媒体轨道', async () => {
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    await wrapper.findAll('.private-call__video-actions button')[0]!.trigger('click');
    await wrapper.findAll('.private-call__video-actions button')[2]!.trigger('click');
    expect(mocks.audioTrack.enabled).toBe(false);
    expect(mocks.videoTrack.enabled).toBe(false);
    expect(wrapper.text()).toContain('摄像头已关闭');
    await wrapper.findAll('.private-call__video-actions button')[0]!.trigger('click');
    await wrapper.findAll('.private-call__video-actions button')[2]!.trigger('click');
    expect(mocks.audioTrack.enabled).toBe(true);
    expect(mocks.videoTrack.enabled).toBe(true);
    wrapper.unmount();
  });

  it('视频浮窗可以通过画面拖动', async () => {
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    await wrapper.find('.private-call__fullscreen').trigger('click');
    const panel = wrapper.find('.private-call').element as HTMLElement;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      left: 16,
      top: 20,
      width: 300,
      height: 260,
    } as DOMRect);
    wrapper
      .find('.private-call__remote')
      .element.dispatchEvent(
        new MouseEvent('pointerdown', { clientX: 30, clientY: 40, bubbles: true }),
      );
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 220 }));
    await nextTick();
    expect(panel.style.left).toBe('186px');
    expect(panel.style.top).toBe('200px');
    window.dispatchEvent(new Event('pointerup'));
    wrapper.unmount();
  });

  it.each([0, 2])('在任意页面收到类型 %s 并直接接听，回复实际来电者', async (type) => {
    const wrapper = render();
    request(type);
    await nextTick();
    expect(wrapper.text()).toContain('Alice');
    expect(wrapper.findAllComponents(Modal)[0]!.props('show')).toBe(true);
    expect(mocks.startRingtone).toHaveBeenCalledWith('private:alice');
    wrapper.findAllComponents(Modal)[0]!.vm.$emit('positive-click');
    await flushPromises();
    expect(mocks.stopRingtone).toHaveBeenCalledWith('private:alice');
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'alice' },
      accepted: true,
    });
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(type === 1 ? 0 : 1);
    wrapper.unmount();
  });
  it('拒绝不申请媒体权限，且释放忙碌状态', async () => {
    const wrapper = render();
    request(0);
    await nextTick();
    wrapper.findAllComponents(Modal)[0]!.vm.$emit('negative-click');
    await nextTick();
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'alice' },
      accepted: false,
    });
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(usePrivateCallStore().busy).toBe(false);
    wrapper.unmount();
  });
  it('摄像头和麦克风均失败仍接听视频，并保留接收画面和声音的通道', async () => {
    mocks.getUserMedia.mockRejectedValue(new DOMException('设备不可用', 'NotReadableError'));
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'alice' },
      accepted: true,
    });
    expect(mocks.peerInstance.addTransceiver).toHaveBeenCalledWith('audio', {
      direction: 'recvonly',
    });
    expect(mocks.peerInstance.addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'recvonly',
    });
    expect(usePrivateCallStore().busy).toBe(true);
    wrapper.unmount();
  });
  it('麦克风失败时降级为只发送视频，并保持音频接收', async () => {
    mocks.getUserMedia.mockRejectedValueOnce(new DOMException('麦克风不可用', 'NotFoundError'));
    mocks.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [mocks.videoTrack],
      getAudioTracks: () => [],
      getVideoTracks: () => [mocks.videoTrack],
    });
    const wrapper = render();
    request(0);
    wrapper.findComponent(Modal).vm.$emit('positive-click');
    await flushPromises();
    expect(mocks.getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.anything() });
    expect(mocks.peerInstance.addTransceiver).toHaveBeenCalledWith('audio', {
      direction: 'recvonly',
    });
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'alice' },
      accepted: true,
    });
    wrapper.unmount();
  });
  it('主叫方设备失败仍发出邀请，并以纯接收连接继续通话', async () => {
    mocks.getUserMedia.mockRejectedValue(new DOMException('设备不可用', 'NotReadableError'));
    const wrapper = render();
    usePrivateCallStore().request = { user: { id: 1, socketId: 'alice' }, type: 0 };
    await flushPromises();
    expect(mocks.emit).toHaveBeenCalledWith(
      'webrtc_call_request',
      expect.objectContaining({ deviceType: 0 }),
    );
    mocks.handlers.get('webrtc_call_response')!({ from: 'alice', accepted: true });
    await flushPromises();
    expect(mocks.peerInstance.addTransceiver).toHaveBeenCalledWith('audio', {
      direction: 'recvonly',
    });
    expect(mocks.peerInstance.addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'recvonly',
    });
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_offer', expect.anything());
    wrapper.unmount();
  });
  it('来电取消会关闭邀请，其他人的挂断不影响当前来电', async () => {
    const wrapper = render();
    request(0);
    mocks.handlers.get('webrtc_hangup')!({ from: 'outsider' });
    await nextTick();
    expect(wrapper.findAllComponents(Modal)[0]!.props('show')).toBe(true);
    mocks.handlers.get('webrtc_hangup')!({ from: 'alice' });
    await nextTick();
    expect(wrapper.findAllComponents(Modal)[0]!.props('show')).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(mocks.handlers.size).toBe(0);
  });
  it('聊天页只提交呼叫请求，全局实例负责发送和断线清理', async () => {
    const wrapper = render();
    usePrivateCallStore().request = { user: { id: 1, socketId: 'alice' }, type: 0 };
    await flushPromises();
    expect(mocks.emit).toHaveBeenCalledWith(
      'webrtc_call_request',
      expect.objectContaining({ to: { id: 1, socketId: 'alice' }, deviceType: 0 }),
    );
    expect((wrapper.find('.private-call__self video').element as HTMLVideoElement).srcObject).toBe(
      await mocks.getUserMedia.mock.results[0]!.value,
    );
    mocks.handlers.get('disconnect')!();
    expect(mocks.stop).toHaveBeenCalled();
    expect(usePrivateCallStore().busy).toBe(false);
    wrapper.unmount();
  });
  it('远控占用时拒绝来电和呼出，不请求设备权限或抢占会话', async () => {
    const remote = mediaOccupancy.acquire('remote-control', 'remote-test')!;
    const wrapper = render();
    request(0);
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'alice' },
      accepted: false,
    });
    usePrivateCallStore().request = { user: { id: 1, socketId: 'alice' }, type: 0 };
    await flushPromises();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    expect(remote.isCurrent()).toBe(true);
    wrapper.unmount();
    remote.release();
  });
  it('设备权限弹窗期间取消，迟到流只停止自身并保留新远控占用', async () => {
    let resolve!: (value: unknown) => void;
    mocks.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = render();
    usePrivateCallStore().request = { user: { id: 1, socketId: 'alice' }, type: 0 };
    mediaOccupancy.stop('CANCELLED');
    const remote = mediaOccupancy.acquire('remote-control', 'remote-after-cancel')!;
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] });
    await flushPromises();
    expect(stop).toHaveBeenCalledOnce();
    expect(remote.isCurrent()).toBe(true);
    expect(mocks.emit).not.toHaveBeenCalledWith('webrtc_call_request', expect.anything());
    wrapper.unmount();
    remote.release();
  });
});
