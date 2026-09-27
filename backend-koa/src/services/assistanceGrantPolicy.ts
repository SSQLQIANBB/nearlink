import { Op } from 'sequelize';
import { z } from 'zod';

export const assistanceDuration = z.enum(['15m', '1h', 'permanent']);
export type AssistanceDuration = z.infer<typeof assistanceDuration>;
export function assistanceExpiry(duration: AssistanceDuration, now = Date.now()): Date | null {
  return duration === 'permanent' ? null : new Date(now + (duration === '1h' ? 3600000 : 900000));
}
/** Null is an explicitly selected long-lived invitation, never a media/input authorization. */
export function activeAssistanceWhere(now = new Date()) {
  return { revokedAt: null, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }] };
}
export function assistanceExpired(expiresAt: Date | null, now = Date.now()) {
  return expiresAt !== null && expiresAt.getTime() <= now;
}
