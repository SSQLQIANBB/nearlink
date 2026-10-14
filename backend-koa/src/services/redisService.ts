import redis, { REDIS_KEYS, REDIS_TTL } from '../config/redis';

/**
 * Redis缓存服务
 */
class RedisService {
  /**
   * 设置用户信息缓存
   */
  async setUserInfo(userId: number, userInfo: any): Promise<void> {
    const key = REDIS_KEYS.USER_INFO + userId;
    await redis.setex(key, REDIS_TTL.USER_INFO, JSON.stringify(userInfo));
  }

  /**
   * 获取用户信息缓存
   */
  async getUserInfo(userId: number): Promise<any | null> {
    const key = REDIS_KEYS.USER_INFO + userId;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 删除用户信息缓存
   */
  async delUserInfo(userId: number): Promise<void> {
    const key = REDIS_KEYS.USER_INFO + userId;
    await redis.del(key);
  }

  /**
   * 设置用户在线状态
   */
  async setUserStatus(userId: number, status: 'online' | 'offline' | 'busy'): Promise<void> {
    const key = REDIS_KEYS.USER_STATUS + userId;
    await redis.setex(key, REDIS_TTL.USER_STATUS, status);

    // 同时更新在线用户集合
    if (status === 'online') {
      await redis.sadd(REDIS_KEYS.ONLINE_USERS, userId.toString());
    } else {
      await redis.srem(REDIS_KEYS.ONLINE_USERS, userId.toString());
    }
  }

  /**
   * 获取用户在线状态
   */
  async getUserStatus(userId: number): Promise<string | null> {
    const key = REDIS_KEYS.USER_STATUS + userId;
    return await redis.get(key);
  }

  /**
   * 获取所有在线用户ID列表
   */
  async getOnlineUsers(): Promise<number[]> {
    const userIds = await redis.smembers(REDIS_KEYS.ONLINE_USERS);
    return userIds.map((id) => parseInt(id));
  }

  /**
   * 设置用户Socket映射
   */
  async setUserSocket(userId: number, socketId: string): Promise<void> {
    const key = REDIS_KEYS.USER_SOCKET + userId;
    await redis.setex(key, REDIS_TTL.USER_STATUS, socketId);
  }

  /**
   * 获取用户Socket ID
   */
  async getUserSocket(userId: number): Promise<string | null> {
    const key = REDIS_KEYS.USER_SOCKET + userId;
    return await redis.get(key);
  }

  /**
   * 删除用户Socket映射
   */
  async delUserSocket(userId: number): Promise<void> {
    const key = REDIS_KEYS.USER_SOCKET + userId;
    await redis.del(key);
  }

  /**
   * 设置群组信息缓存
   */
  async setGroupInfo(groupId: number, groupInfo: any): Promise<void> {
    const key = REDIS_KEYS.GROUP_INFO + groupId;
    await redis.setex(key, REDIS_TTL.GROUP_INFO, JSON.stringify(groupInfo));
  }

  /**
   * 获取群组信息缓存
   */
  async getGroupInfo(groupId: number): Promise<any | null> {
    const key = REDIS_KEYS.GROUP_INFO + groupId;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 删除群组信息缓存
   */
  async delGroupInfo(groupId: number): Promise<void> {
    const key = REDIS_KEYS.GROUP_INFO + groupId;
    await redis.del(key);
  }

  /**
   * 设置群组成员列表缓存
   */
  async setGroupMembers(groupId: number, members: any[]): Promise<void> {
    const key = REDIS_KEYS.GROUP_MEMBERS + groupId;
    await redis.setex(key, REDIS_TTL.GROUP_MEMBERS, JSON.stringify(members));
  }

  /**
   * 获取群组成员列表缓存
   */
  async getGroupMembers(groupId: number): Promise<any[] | null> {
    const key = REDIS_KEYS.GROUP_MEMBERS + groupId;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 删除群组成员列表缓存
   */
  async delGroupMembers(groupId: number): Promise<void> {
    const key = REDIS_KEYS.GROUP_MEMBERS + groupId;
    await redis.del(key);
  }

  /**
   * 设置会话缓存
   */
  async setSession(token: string, sessionData: any): Promise<void> {
    const key = REDIS_KEYS.SESSION + token;
    await redis.setex(key, REDIS_TTL.SESSION, JSON.stringify(sessionData));
  }

  /**
   * 获取会话缓存
   */
  async getSession(token: string): Promise<any | null> {
    const key = REDIS_KEYS.SESSION + token;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 删除会话缓存
   */
  async delSession(token: string): Promise<void> {
    const key = REDIS_KEYS.SESSION + token;
    await redis.del(key);
  }

  /**
   * 批量删除缓存（支持通配符）
   */
  async delPattern(pattern: string): Promise<number> {
    const keys = await redis.keys(pattern);
    if (keys.length === 0) return 0;
    return await redis.del(...keys);
  }

  /**
   * 保存 refresh token
   */
  async setRefreshToken(userId: number, refreshToken: string): Promise<void> {
    const key = REDIS_KEYS.REFRESH_TOKEN + userId;
    await redis.setex(key, REDIS_TTL.REFRESH_TOKEN, refreshToken);
  }

  /**
   * 获取 refresh token
   */
  async getRefreshToken(userId: number): Promise<string | null> {
    const key = REDIS_KEYS.REFRESH_TOKEN + userId;
    return await redis.get(key);
  }

  /**
   * 删除 refresh token（用于登出）
   */
  async delRefreshToken(userId: number): Promise<void> {
    const key = REDIS_KEYS.REFRESH_TOKEN + userId;
    await redis.del(key);
  }

  /**
   * 验证 refresh token 是否匹配
   */
  async verifyRefreshToken(userId: number, refreshToken: string): Promise<boolean> {
    const storedToken = await this.getRefreshToken(userId);
    return storedToken === refreshToken;
  }
}

export default new RedisService();
