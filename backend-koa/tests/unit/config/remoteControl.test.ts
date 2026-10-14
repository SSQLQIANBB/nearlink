import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock('../../../src/services/loginSessionService', () => ({
  validateAuthenticatedSession: mock.validate,
}));
vi.mock('../../../src/services/remoteControlContext', () => ({
  getRemoteControlContext: () => ({
    authority: null,
    coordinator: null,
    service: { subscribe: () => () => {} },
    store: {},
    history: {},
  }),
}));
vi.mock('../../../src/models/RemoteControl', () => ({ AssistanceGrant: {} }));
import { initializeRemoteControl } from '../../../src/config/remoteControl';
import { getRemoteControlCapabilities } from '../../../src/services/remoteControlPolicy';

describe('远控认证与服务就绪检查', () => {
  it('服务未就绪时，客户端自报权限不能绕过namespace校验', async () => {
    const use = vi.fn();
    const of = vi.fn(() => ({ use, on: vi.fn() }));
    initializeRemoteControl({ of, engine: { once: vi.fn() } } as any);
    expect(of).toHaveBeenCalledWith('/remote-control');
    mock.validate.mockResolvedValue({ userId: 1, sid: 'login' });
    const next = vi.fn();
    await use.mock.calls[0][0](
      {
        handshake: {
          auth: { token: 'valid', role: 'host', engineReady: true, canInjectInput: true },
        },
      },
      next,
    );
    expect(next.mock.calls[0][0].data.code).toBe('REMOTE_SERVICE_UNAVAILABLE');
    expect(getRemoteControlCapabilities()).toMatchObject({
      desktopHostEnabled: true,
      desktopControllerEnabled: true,
      webControllerReleaseEnabled: true,
      releasedPlatforms: ['macos', 'windows'],
    });
  });
  it('旧sid/缺少凭据均拒绝，不作为匿名功能协商放行', async () => {
    const use = vi.fn();
    initializeRemoteControl({ of: () => ({ use, on: vi.fn() }), engine: { once: vi.fn() } } as any);
    mock.validate.mockRejectedValue(new Error('revoked'));
    const next = vi.fn();
    await use.mock.calls[0][0]({ handshake: { auth: { token: 'expired' } } }, next);
    expect(next.mock.calls[0][0].data.code).toBe('AUTH_REVOKED');
  });
});
