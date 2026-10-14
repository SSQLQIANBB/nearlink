import type { Context } from 'koa';
import { z } from 'zod';
import UserNotificationSettings from '../models/UserNotificationSettings';

const settingsSchema = z
  .object({
    desktopEnabled: z.boolean(),
    messagePreview: z.boolean(),
    notifyPrivateMessage: z.boolean(),
    notifyGroupMessage: z.boolean(),
    notifyCall: z.boolean(),
    notifyInvitation: z.boolean(),
    messageEnabled: z.boolean(),
    callEnabled: z.boolean(),
    messageTone: z.enum(['default', 'happy']),
    callTone: z.enum(['default', 'classic']),
  })
  .strict();

export async function getNotificationSettings(ctx: Context) {
  const [record] = await UserNotificationSettings.findOrCreate({
    where: { userId: ctx.state.user.userId },
  });
  const { userId, ...settings } = record.get({ plain: true });
  ctx.body = { settings };
}

export async function updateNotificationSettings(ctx: Context) {
  const parsed = settingsSchema.partial().safeParse(ctx.request.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    ctx.status = 400;
    ctx.body = { error: '通知设置格式无效' };
    return;
  }
  const [record] = await UserNotificationSettings.findOrCreate({
    where: { userId: ctx.state.user.userId },
  });
  // 只写本次变更的字段，另一设备修改其他开关时不会被旧快照覆盖。
  await record.update(parsed.data);
  await record.reload();
  const { userId, ...settings } = record.get({ plain: true });
  ctx.body = { settings };
}
