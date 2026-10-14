import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { invoke, isPermissionGranted } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    'Audio',
    class {
      src = '';
      play = vi.fn().mockResolvedValue(undefined);
      pause() {}
    },
  );
  vi.stubGlobal('Notification', { permission: 'granted' });
  isPermissionGranted.mockResolvedValue(true);
  invoke.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('Windows 系统通知', () => {
  it('复用隐私设置，通过原生接口发送且不调用浏览器 close', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    service.updatePreferences({ messagePreview: false });
    expect(await service.showMessage('小明', '敏感消息')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: { title: '新消息 - 小明', body: '收到一条私聊消息' },
    });
  });

  it('账号关闭通知或权限未授予时不发送', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    service.disable();
    expect(await service.showSystem('测试', '测试')).toBe(false);
    service.enable();
    isPermissionGranted.mockResolvedValue(false);
    expect(await service.showSystem('测试', '测试')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('原生调用失败返回失败状态', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    invoke.mockRejectedValue(new Error('notification unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await service.showSystem('测试', '测试')).toBe(false);
    vi.restoreAllMocks();
  });
});
