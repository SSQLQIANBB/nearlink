import Redis from 'ioredis';
import { env } from './env';

// Redis配置
const redisConfig = {
  ...env.redis,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
};

// 创建Redis实例
const redis = new Redis(redisConfig);

// 连接事件监听
redis.on('connect', () => {
  console.log('✓ Redis 连接成功');
});

redis.on('error', (error) => {
  console.error('✗ Redis 连接错误:', error.message);
});

redis.on('ready', () => {
  console.log('✓ Redis 准备就绪');
});

redis.on('reconnecting', () => {
  console.log('⟳ Redis 重新连接中...');
});

// Redis缓存键前缀
export const REDIS_KEYS = {
  USER_INFO: 'user:info:', // 用户信息 user:info:{userId}
  USER_STATUS: 'user:status:', // 用户在线状态 user:status:{userId}
  USER_SOCKET: 'user:socket:', // 用户Socket映射 user:socket:{userId}
  GROUP_INFO: 'group:info:', // 群组信息 group:info:{groupId}
  GROUP_MEMBERS: 'group:members:', // 群组成员列表 group:members:{groupId}
  ONLINE_USERS: 'online:users', // 在线用户集合
  SESSION: 'session:', // 会话信息 session:{token}
  REFRESH_TOKEN: 'refresh:token:', // refresh token refresh:token:{userId}
};

// Redis缓存过期时间（秒）
export const REDIS_TTL = {
  USER_INFO: 3600, // 用户信息 1小时
  USER_STATUS: 1800, // 用户状态 30分钟
  GROUP_INFO: 3600, // 群组信息 1小时
  GROUP_MEMBERS: 1800, // 群组成员 30分钟
  SESSION: 86400, // 会话 24小时
  REFRESH_TOKEN: 86400, // refresh token 24小时
};

export default redis;
