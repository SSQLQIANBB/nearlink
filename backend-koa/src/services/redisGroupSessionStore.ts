import redis from '../config/redis';
import {
  type GroupSession,
  type GroupSessionStore,
} from './groupSessionService';

const GROUP_SESSION_TTL_SECONDS = 12 * 60 * 60;

export class RedisGroupSessionStore implements GroupSessionStore {
  async create(key: string, session: GroupSession) {
    const result = await redis.set(
      key,
      JSON.stringify(session),
      'EX',
      GROUP_SESSION_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  async get(key: string) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) as GroupSession : null;
  }

  async delete(key: string, expected: GroupSession) {
    // An old disconnect cannot delete a replacement session after GET.
    return Number(await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0`,
      1, key, JSON.stringify(expected),
    )) > 0;
  }
}
