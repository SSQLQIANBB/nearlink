import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  sessions: vi.fn(),
  probe: vi.fn(),
}));
vi.mock('@/api/remoteControl', () => ({
  getRemoteControlRelease: mocks.release,
  getRemoteSessions: mocks.sessions,
}));
vi.mock('@/services/remoteControlCapabilities', () => ({ probeRemoteCapabilities: mocks.probe }));
import { useRemoteControlStore } from '@/stores/remoteControl';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.release.mockResolvedValue({});
  mocks.probe.mockResolvedValue({ canControl: false, showControllerEntry: false });
});

describe('远控会话前端门禁', () => {
  it('焦点刷新保留设置面板，同时暂停新请求，失败后关闭入口', async () => {
    mocks.probe.mockResolvedValueOnce({
      canControl: true,
      showControllerEntry: true,
      showHostEntry: true,
    });
    const store = useRemoteControlStore();
    await store.refreshCapabilities();
    let reject!: (reason: Error) => void;
    mocks.release.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = store.refreshCapabilities();
    expect(store.capabilities?.showHostEntry).toBe(true);
    expect(store.canControl).toBe(false);
    reject(new Error('offline'));
    await pending;
    expect(store.canControl).toBe(false);
    expect(store.capabilities?.showHostEntry).not.toBe(true);
  });
  it('配置未开放时不查询其他用户设备或连接记录', async () => {
    const store = useRemoteControlStore();
    await store.refreshCapabilities();
    await store.loadSessions();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it('退出后迟到的能力响应不能恢复权限', async () => {
    let resolve!: (value: object) => void;
    mocks.release.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mocks.probe.mockResolvedValue({ canControl: true, showControllerEntry: true });
    const store = useRemoteControlStore();
    const pending = store.refreshCapabilities();
    store.reset();
    resolve({});
    await pending;
    expect(store.canControl).toBe(false);
    expect(store.capabilities).toBeNull();
  });
});
