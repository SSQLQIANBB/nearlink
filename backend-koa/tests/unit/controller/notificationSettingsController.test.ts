import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findOrCreate: vi.fn() }));
vi.mock('../../../src/models/UserNotificationSettings', () => ({
  default: { findOrCreate: mocks.findOrCreate },
}));
import {
  getNotificationSettings,
  updateNotificationSettings,
} from '../../../src/controller/notificationSettingsController';

const defaults = {
  desktopEnabled: true,
  messagePreview: true,
  notifyPrivateMessage: true,
  notifyGroupMessage: true,
  notifyCall: true,
  notifyInvitation: true,
  messageEnabled: true,
  callEnabled: true,
  messageTone: 'default',
  callTone: 'default',
};
const records = new Map<number, Record<string, unknown>>();
beforeEach(() => {
  records.clear();
  vi.clearAllMocks();
  mocks.findOrCreate.mockImplementation(async ({ where: { userId } }) => {
    if (!records.has(userId)) records.set(userId, { userId, ...defaults });
    return [
      {
        get: () => ({ ...records.get(userId) }),
        update: async (value: object) => Object.assign(records.get(userId)!, value),
        reload: async () => {},
      },
    ];
  });
});
const context = (userId: number, body?: unknown) =>
  ({ state: { user: { userId } }, request: { body }, status: 200 }) as any;

describe('服务端通知偏好', () => {
  it('同一账号另一设备读回设置，另一账号不受影响，局部修改不会覆盖其他字段', async () => {
    await updateNotificationSettings(context(7, { callTone: 'classic', messagePreview: false }));
    await updateNotificationSettings(context(7, { notifyCall: false }));
    const secondDevice = context(7);
    await getNotificationSettings(secondDevice);
    expect(secondDevice.body).toEqual({
      settings: { ...defaults, callTone: 'classic', messagePreview: false, notifyCall: false },
    });
    const other = context(8);
    await getNotificationSettings(other);
    expect(other.body.settings).toEqual(defaults);
  });

  it.each([
    { userId: 8, notifyCall: false },
    { callTone: 'invalid' },
    { messageEnabled: 'false' },
    {},
    null,
  ])('拒绝非法输入 %j', async (body) => {
    const ctx = context(7, body);
    await updateNotificationSettings(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.findOrCreate).not.toHaveBeenCalled();
  });
});
