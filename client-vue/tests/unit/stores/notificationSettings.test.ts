import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  preferences: vi.fn(),
  sounds: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
vi.mock('@/utils/request', () => ({ http: { get: mocks.get, put: mocks.put } }));
vi.mock('@/services/notificationService', () => ({
  default: {
    updatePreferences: mocks.preferences,
    updateSoundPreferences: mocks.sounds,
    enable: mocks.enable,
    disable: mocks.disable,
  },
}));
import { defaultNotificationSettings as defaults } from '../../../src/api/notificationSettings';
import { useNotificationSettingsStore } from '../../../src/stores/notificationSettings';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('账号通知设置', () => {
  it('新设备加载服务端偏好，同时应用通知和音效', async () => {
    const saved = { ...defaults, desktopEnabled: false, notifyCall: false, callTone: 'classic' };
    mocks.get.mockResolvedValue({ settings: saved });
    const store = useNotificationSettingsStore();
    await store.load(1);
    expect(store.settings).toEqual(saved);
    expect(mocks.disable).toHaveBeenCalled();
    expect(mocks.sounds).toHaveBeenLastCalledWith(expect.objectContaining({ callTone: 'classic' }));
    expect(mocks.preferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ notifyCall: false }),
    );
  });

  it('只保存改动字段，成功前禁用控件，失败保留原值，可重试', async () => {
    mocks.get.mockResolvedValue({ settings: defaults });
    const store = useNotificationSettingsStore();
    await store.load(1);
    mocks.put.mockRejectedValueOnce(new Error('offline'));
    const saving = store.save({ messagePreview: false });
    expect(store.disabled).toBe(true);
    await store.save({ notifyCall: false });
    await saving;
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(store.settings.messagePreview).toBe(true);
    expect(store.error).toContain('保存失败');
    mocks.put.mockResolvedValueOnce({ settings: { ...defaults, messagePreview: false } });
    await store.save({ messagePreview: false });
    expect(mocks.put).toHaveBeenLastCalledWith('/api/auth/notification-settings', {
      messagePreview: false,
    });
    expect(store.settings.messagePreview).toBe(false);
    expect(store.error).toBe('');
  });

  it('重复加载共用请求，切换账号后丢弃旧请求和旧偏好', async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = useNotificationSettingsStore();
    const old = store.load(1);
    const duplicate = store.load(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValueOnce({ settings: { ...defaults, notifyGroupMessage: false } });
    await store.load(2);
    finish({ settings: { ...defaults, notifyCall: false } });
    await Promise.all([old, duplicate]);
    expect(store.settings.notifyCall).toBe(true);
    expect(store.settings.notifyGroupMessage).toBe(false);
    store.reset();
    expect(store.settings).toEqual(defaults);
  });

  it('加载失败禁止写入默认值，重试后恢复', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline'));
    const store = useNotificationSettingsStore();
    await store.load(1);
    await store.save({ notifyCall: false });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(store.status).toBe('error');
    mocks.get.mockResolvedValueOnce({ settings: defaults });
    await store.load(1);
    expect(store.status).toBe('ready');
  });
});
