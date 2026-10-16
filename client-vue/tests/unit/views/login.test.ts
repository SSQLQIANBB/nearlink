import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginView from '../../../src/views/login.vue';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  replace: vi.fn(),
  setAuth: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  sendCode: vi.fn(),
}));

vi.mock('@/api/auth', () => ({
  register: vi.fn(),
  sendEmailCode: mocks.sendCode,
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ setAuth: mocks.setAuth, login: mocks.login }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    useMessage: () => ({ error: mocks.error, success: mocks.success }),
  };
});

const FormStub = defineComponent({
  template: '<form><slot /></form>',
  setup(_, { expose }) {
    expose({ validate: () => Promise.resolve() });
  },
});

const ButtonStub = defineComponent({
  props: {
    loading: Boolean,
    disabled: Boolean,
  },
  emits: ['click'],
  template: `
    <button
      type="button"
      :disabled="disabled"
      :data-loading="String(loading)"
      @click="$emit('click')"
    ><slot /></button>
  `,
});

const InputStub = defineComponent({
  props: { value: String },
  emits: ['update:value'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.value,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      });
  },
});

function mountLogin() {
  return mount(LoginView, {
    global: {
      stubs: {
        NCard: { template: '<section><slot name="header" /><slot /></section>' },
        NTabs: { template: '<div><slot /></div>' },
        NTabPane: { template: '<div><slot /></div>' },
        NForm: FormStub,
        NFormItem: { template: '<label><slot /></label>' },
        NInput: InputStub,
        NButton: ButtonStub,
        NIcon: { template: '<i />' },
      },
    },
  });
}

describe('login button state', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    window.localStorage.clear();
  });

  it('请求期间按钮 loading 且禁用，重复点击不会发送第二次请求', async () => {
    let resolveLogin!: (value: any) => void;
    mocks.login.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const wrapper = mountLogin();
    const button = wrapper.findAll('button').find((item) => item.text() === '登录')!;

    await button.trigger('click');
    await flushPromises();

    expect(button.attributes('data-loading')).toBe('true');
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(mocks.login).toHaveBeenCalledTimes(1);

    resolveLogin({
      user: { id: 1, username: 'owner' },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    await flushPromises();
  });

  it('登录失败或异常后恢复按钮状态', async () => {
    mocks.login.mockRejectedValue(new Error('登录失败'));
    const wrapper = mountLogin();
    const button = wrapper.findAll('button').find((item) => item.text() === '登录')!;

    await button.trigger('click');
    await flushPromises();

    expect(button.attributes('data-loading')).toBe('false');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith('登录失败');
  });

  it('验证码登录发送专用验证码并沿用原有登录跳转', async () => {
    mocks.sendCode.mockResolvedValue({ message: '验证码已发送' });
    mocks.login.mockResolvedValue({
      user: { id: 1, username: 'owner' },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      message: '登录成功',
    });
    const wrapper = mountLogin();
    expect(wrapper.findAll('button').some((button) => button.text() === '返回账号密码登录')).toBe(
      false,
    );
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '验证码免密登录')!
      .trigger('click');
    const emailForm = wrapper.findAll('form')[0]!;
    expect(emailForm.findAll('button').some((button) => button.text() === '返回账号密码登录')).toBe(
      true,
    );
    const inputs = emailForm.findAll('input');
    await inputs[0]!.setValue('alice@example.com');
    await emailForm.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(mocks.sendCode).toHaveBeenCalledWith('login', 'alice@example.com');
    expect(emailForm.findAll('button')[0]!.text()).toContain('后重发');

    await inputs[1]!.setValue('123456');
    await emailForm.findAll('button')[1]!.trigger('click');
    await flushPromises();
    expect(mocks.login).toHaveBeenCalledWith({ email: 'alice@example.com', code: '123456' });
    expect(mocks.replace).toHaveBeenCalledWith('/remote');
    await emailForm
      .findAll('button')
      .find((button) => button.text() === '返回账号密码登录')!
      .trigger('click');
    expect(wrapper.findAll('button').some((button) => button.text() === '验证码免密登录')).toBe(
      true,
    );
    wrapper.unmount();
  });
});
