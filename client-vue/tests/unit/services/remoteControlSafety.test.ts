import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => mocks);
import {
  registerRemoteControlCleanup,
  stopRemoteControlLocally,
} from '@/services/remoteControlSafety';
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe('原生退出时限', () => {
  it('先同步释放本地输入，原生停止长挂1500ms后仍允许继续撤销身份', async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    const cleaned = vi.fn();
    const unregister = registerRemoteControlCleanup(cleaned);
    const pending = stopRemoteControlLocally('LOGOUT');
    expect(cleaned).toHaveBeenCalledWith('LOGOUT');
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_stop');
    const rejected = expect(pending).rejects.toThrow('REMOTE_LOCAL_STOP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    unregister();
  });
  it('Web退出仅清理本地会话，不调用原生命令', async () => {
    mocks.isTauri.mockReturnValue(false);
    await stopRemoteControlLocally('LOGOUT');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
