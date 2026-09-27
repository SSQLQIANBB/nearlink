import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mocks = vi.hoisted(() => ({ release: vi.fn(), targets: vi.fn(), sessions: vi.fn(), probe: vi.fn() }));
vi.mock('@/api/remoteControl', () => ({ getRemoteControlRelease: mocks.release, getRemoteTargets: mocks.targets, getRemoteSessions: mocks.sessions }));
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
    mocks.probe.mockResolvedValueOnce({ canControl: true, showControllerEntry: true, showHostEntry: true });
    const store = useRemoteControlStore();
    await store.refreshCapabilities();
    let reject!: (reason: Error) => void;
    mocks.release.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = store.refreshCapabilities();
    expect(store.capabilities?.showHostEntry).toBe(true);
    expect(store.canControl).toBe(false);
    await store.loadTargets(1);
    expect(mocks.targets).not.toHaveBeenCalled();
    reject(new Error('offline'));
    await pending;
    expect(store.canControl).toBe(false);
    expect(store.capabilities?.showHostEntry).not.toBe(true);
  });
  it('配置未开放时不查询其他用户设备或连接记录', async () => {
    const store = useRemoteControlStore();
    await store.refreshCapabilities();
    await store.loadTargets(4);
    await store.loadSessions();
    expect(mocks.targets).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it('退出后迟到的能力响应不能恢复权限', async () => {
    let resolve!: (value: object) => void;
    mocks.release.mockImplementation(() => new Promise(done => { resolve = done; }));
    mocks.probe.mockResolvedValue({ canControl: true, showControllerEntry: true });
    const store = useRemoteControlStore();
    const pending = store.refreshCapabilities();
    store.reset();
    resolve({});
    await pending;
    expect(store.canControl).toBe(false);
    expect(store.capabilities).toBeNull();
  });
  it('切换联系人后丢弃前一个联系人的迟到设备响应', async () => {
    mocks.probe.mockResolvedValue({ canControl: true, showControllerEntry: true });
    const store = useRemoteControlStore();
    await store.refreshCapabilities();
    let resolve!: (value: object) => void;
    mocks.targets.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const old = store.loadTargets(3);
    mocks.targets.mockResolvedValueOnce({ targets: [{ deviceId: 'new' }] });
    await store.loadTargets(4);
    resolve({ targets: [{ deviceId: 'old' }] });
    await old;
    expect(store.targets.map(target => target.deviceId)).toEqual(['new']);
  });
});
