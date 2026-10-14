import redis from '../config/redis';
import { type AnnotationAction, type ScreenAnnotationStore } from './screenAnnotationService';

const ANNOTATION_TTL_SECONDS = 12 * 60 * 60;

export class RedisScreenAnnotationStore implements ScreenAnnotationStore {
  async get(key: string) {
    const value = await redis.get(key);
    return value ? (JSON.parse(value) as AnnotationAction[]) : [];
  }

  async set(key: string, actions: AnnotationAction[]) {
    await redis.set(key, JSON.stringify(actions), 'EX', ANNOTATION_TTL_SECONDS);
  }

  async delete(key: string) {
    await redis.del(key);
  }
}
