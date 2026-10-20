import { flushPromises, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrivateCallStore } from '../../../src/stores/privateCall';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  emit: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  incomingStart: vi.fn(),
  incomingStop: vi.fn(),
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
vi.mock('naive-ui', async (original) => ({
  ...(await original<typeof import('naive-ui')>()),
  useMessage: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/services/notificationService', () => ({
  default: {
    startOutgoingRingtone: mocks.start,
    stopOutgoingRingtone: mocks.stop,
    startCallRingtone: mocks.incomingStart,
    stopCallRingtone: mocks.incomingStop,
    getSoundPreferences: () => ({ callTone: 'classic' }),
    showCall: vi.fn(),
  },
}));
import GlobalPrivateCall from '../../../src/components/GlobalPrivateCall.vue';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  setActivePinia(createPinia());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [],
        getAudioTracks: () => [],
        getVideoTracks: () => [],
      }),
    },
  });
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      close() {}
      async createOffer() {
        return { type: 'offer', sdp: '' };
      }
      async setLocalDescription() {}
    },
  );
});

async function dial() {
  const wrapper = shallowMount(GlobalPrivateCall);
  usePrivateCallStore().request = { user: { id: 2, socketId: 'bob', nickname: 'Bob' }, type: 2 };
  await flushPromises();
  const request = mocks.emit.mock.calls.find(([event]) => event === 'webrtc_call_request')![1];
  return { wrapper, ringing: { from: 'bob', callId: request.callId, tone: 'classic' } };
}

describe('私聊回铃生命周期', () => {
  it('主动挂断后停止回铃，下一次呼叫不接受上一次回传', async () => {
    const { wrapper, ringing } = await dial();
    const handleRinging = mocks.handlers.get('webrtc_call_ringing')!;
    handleRinging(ringing);
    await wrapper.find('button[aria-label="挂断"]').trigger('click');
    await flushPromises();
    expect(mocks.emit).toHaveBeenCalledWith(
      'webrtc_hangup',
      expect.objectContaining({ to: expect.objectContaining({ socketId: 'bob' }) }),
    );
    expect(mocks.stop).toHaveBeenCalled();
    usePrivateCallStore().request = { user: { id: 2, socketId: 'bob' }, type: 2 };
    await flushPromises();
    handleRinging(ringing);
    expect(mocks.start).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
  it.each([true, false])(
    '等待时播放对方铃声，响应 accepted=%s 后停止并忽略迟到回传',
    async (accepted) => {
      const { wrapper, ringing } = await dial();
      const handleRinging = mocks.handlers.get('webrtc_call_ringing')!;
      handleRinging({ ...ringing, callId: 'old-call' });
      expect(mocks.start).not.toHaveBeenCalled();
      handleRinging(ringing);
      handleRinging(ringing);
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith('classic');
      mocks.stop.mockClear();
      mocks.handlers.get('webrtc_call_response')!({ from: 'bob', accepted });
      await flushPromises();
      expect(mocks.stop).toHaveBeenCalled();
      handleRinging(ringing);
      expect(mocks.start).toHaveBeenCalledOnce();
      wrapper.unmount();
    },
  );

  it.each(['webrtc_hangup', 'disconnect'])('%s 结束回铃并忽略后续回传', async (event) => {
    const { wrapper, ringing } = await dial();
    const handleRinging = mocks.handlers.get('webrtc_call_ringing')!;
    handleRinging(ringing);
    mocks.stop.mockClear();
    mocks.handlers.get(event)!({ from: 'bob' });
    expect(mocks.stop).toHaveBeenCalledOnce();
    handleRinging(ringing);
    expect(mocks.start).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('来电回传本地铃声选择，拒绝后停止来电铃声', async () => {
    const wrapper = shallowMount(GlobalPrivateCall);
    mocks.handlers.get('webrtc_call_request')!({
      from: 'alice',
      callId: 'invitation',
      deviceType: 2,
      user: { id: 1 },
    });
    expect(mocks.emit).toHaveBeenCalledWith('webrtc_call_ringing', {
      to: { socketId: 'alice' },
      callId: 'invitation',
      tone: 'classic',
    });
    expect(mocks.incomingStart).toHaveBeenCalledWith('private:alice');
    wrapper.findComponent({ name: 'DialogSurface' }).vm.$emit('negative-click');
    await flushPromises();
    expect(mocks.incomingStop).toHaveBeenCalledWith('private:alice');
    wrapper.unmount();
  });
});
