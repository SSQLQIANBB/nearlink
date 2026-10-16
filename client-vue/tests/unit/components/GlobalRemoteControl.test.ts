import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: null as any, auth: null as any }));
vi.mock('@/stores/remoteControlSession', () => ({
  useRemoteControlSessionStore: () => mocks.session,
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/' }) }));
import GlobalRemoteControl from '@/components/GlobalRemoteControl.vue';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  localStorage.clear();
  mocks.auth = reactive({ currentUser: { id: 1 }, authGeneration: 1, loggingOut: false });
  mocks.session = reactive({
    visible: true,
    device: { deviceId: id, alias: '测试电脑' },
    scope: 'view',
    phase: 'active',
    stream: {},
    stats: { framesPerSecond: 30, bitrate: 100000, roundTripMs: 10 },
    attachVideo: vi.fn(),
    pauseInput: vi.fn(),
    end: vi.fn(),
    inputArmed: false,
    continueInput: vi.fn().mockReturnValue(true),
    mapPointer: vi.fn().mockReturnValue({ x: 0.5, y: 0.5 }),
    sendInput: vi.fn().mockReturnValue(true),
    requestControl: vi.fn().mockResolvedValue(undefined),
  });
});
describe('远程画面显示设置', () => {
  it('点击画面启用控制，启用点击不下发孤立的抬起事件，后续点击正常发送', async () => {
    mocks.session.scope = 'control';
    const wrapper = mount(GlobalRemoteControl);
    const video = wrapper.get('video');
    vi.spyOn(wrapper.get('.remote-video-area').element, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 640, bottom: 480,
    } as DOMRect);
    Object.assign(video.element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const click = { button: 0, clientX: 100, clientY: 100 };
    const pointer = (type: string) => {
      const event = new MouseEvent(type, click);
      Object.defineProperty(event, 'pointerId', { value: 1 });
      video.element.dispatchEvent(event);
    };
    pointer('pointerdown');
    expect(mocks.session.continueInput).toHaveBeenCalledOnce();
    mocks.session.inputArmed = true;
    pointer('pointerup');
    expect(mocks.session.sendInput).not.toHaveBeenCalled();
    pointer('pointerdown');
    pointer('pointerup');
    expect(mocks.session.sendInput.mock.calls.map(([event]: any[]) => event.payload.down)).toEqual([true, false]);
    expect(wrapper.text()).not.toContain('继续操作');
    wrapper.unmount();
  });
  it('仅观看不启用输入，需要授权时仍可请求控制许可', async () => {
    mocks.session.needsApproval = true;
    mocks.session.device.canHostControl = true;
    const wrapper = mount(GlobalRemoteControl);
    wrapper.get('video').element.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    expect(mocks.session.continueInput).not.toHaveBeenCalled();
    await wrapper.findAll('button').find((button) => button.text() === '请求控制许可')!.trigger('click');
    expect(mocks.session.requestControl).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
  it('缩放按流尺寸生效并暂停输入，保存后重新打开恢复', async () => {
    let wrapper = mount(GlobalRemoteControl);
    const video = wrapper.get('video');
    Object.defineProperties(video.element, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    await video.trigger('loadedmetadata');
    await wrapper.get('select').setValue('150');
    expect(video.attributes('style')).toContain('width: 1920px');
    expect(video.attributes('style')).toContain('height: 1080px');
    expect(mocks.session.pauseInput).toHaveBeenCalled();
    await wrapper.get('input[type=checkbox]').setValue(false);
    expect(wrapper.find('.stats').exists()).toBe(false);
    wrapper.unmount();
    wrapper = mount(GlobalRemoteControl);
    expect(wrapper.get('select').element.value).toBe('150');
    expect(wrapper.get<HTMLInputElement>('input[type=checkbox]').element.checked).toBe(false);
    wrapper.unmount();
  });
  it('切换账号和设备恢复独立默认，适应窗口不强制像素尺寸', async () => {
    const wrapper = mount(GlobalRemoteControl);
    await wrapper.get('select').setValue('200');
    mocks.auth.currentUser.id = 2;
    await wrapper.vm.$nextTick();
    expect(wrapper.get('select').element.value).toBe('fit');
    await wrapper.get('select').setValue('50');
    mocks.session.device.deviceId = '22222222-2222-4222-8222-222222222222';
    await wrapper.vm.$nextTick();
    expect(wrapper.get('select').element.value).toBe('fit');
    expect(wrapper.get('video').attributes('style') || '').not.toContain('width:');
    wrapper.unmount();
  });
});
