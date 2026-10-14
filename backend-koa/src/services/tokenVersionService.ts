import User from '../models/User';
import { revokeAllLoginSessions } from './loginSessionService';

/** MySQL is the source of truth. Cache loss must never make an old/null version current. */
export async function getTokenVersion(userId: number): Promise<string> {
  const user = await User.findByPk(userId, { attributes: ['authVersion'] });
  if (!user?.authVersion) throw new Error('账号认证版本不存在，请重新登录');
  return user.authVersion;
}

export async function invalidateUserTokens(userId: number): Promise<void> {
  await revokeAllLoginSessions(userId);
}

export async function isTokenVersionCurrent(
  userId: number,
  version?: string | null,
): Promise<boolean> {
  if (!version) return false;
  return version === (await getTokenVersion(userId));
}
