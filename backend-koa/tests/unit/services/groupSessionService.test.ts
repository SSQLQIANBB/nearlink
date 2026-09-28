import { describe, expect, it } from 'vitest';
import {
  GroupSessionService,
  type GroupSession,
  type GroupSessionStore,
} from '../../../src/services/groupSessionService';

class MemorySessionStore implements GroupSessionStore {
  private readonly sessions = new Map<string, GroupSession>();

  async create(key: string, session: GroupSession) {
    if (this.sessions.has(key)) return false;
    this.sessions.set(key, session);
    return true;
  }

  async get(key: string) {
    return this.sessions.get(key) ?? null;
  }

  async delete(key: string) {
    return this.sessions.delete(key);
  }
}

describe('GroupSessionService', () => {
  it('让第二名成员使用与发起者相同的群组视频频道', async () => {
    const service = new GroupSessionService(new MemorySessionStore());

    const started = await service.start(7, 'video', { id: 1, socketId: 'socket-a' });
    const joined = await service.start(7, 'video', { id: 2, socketId: 'socket-b' });

    expect(started.session.channelId).toBe('group:7:video');
    expect(joined.created).toBe(false);
    expect(joined.session.channelId).toBe(started.session.channelId);
    expect(joined.session.ownerUserId).toBe(1);
  });

  it('同时保存视频、语音和屏幕共享状态供后进入成员恢复', async () => {
    const service = new GroupSessionService(new MemorySessionStore());

    await service.start(7, 'video', { id: 1, socketId: 'socket-a' });
    await service.start(7, 'audio', { id: 3, socketId: 'socket-c' });
    await service.start(7, 'screen', { id: 2, socketId: 'socket-b' });

    await expect(service.getGroupState(7)).resolves.toMatchObject({
      video: { channelId: 'group:7:video', ownerUserId: 1 },
      audio: { channelId: 'group:7:audio', ownerUserId: 3 },
      screen: { channelId: 'group:7:screen', ownerUserId: 2 },
    });
  });

  it('非发起者离开不会结束会话，发起者结束后状态恢复为空', async () => {
    const service = new GroupSessionService(new MemorySessionStore());
    await service.start(7, 'video', { id: 1, socketId: 'socket-a' });

    await expect(service.end(7, 'video', 2)).resolves.toBe(false);
    await expect(service.getGroupState(7)).resolves.toMatchObject({
      video: { ownerUserId: 1 },
    });

    await expect(service.end(7, 'video', 1)).resolves.toBe(true);
    await expect(service.getGroupState(7)).resolves.toEqual({
      video: null,
      audio: null,
      screen: null,
    });
  });
});

describe('群会话换代保护', () => {
  it('同账号旧Socket结束请求不得删除新会话', async () => {
    const store = new MemorySessionStore();
    const service = new GroupSessionService(store);
    const old = (await service.start(7, 'video', { id: 1, socketId: 'old' })).session;
    await service.end(7, 'video', 1, old);
    const fresh = (await service.start(7, 'video', { id: 1, socketId: 'new' })).session;
    await expect(service.end(7, 'video', 1, old)).resolves.toBe(false);
    await expect(service.get(7, 'video')).resolves.toEqual(fresh);
    expect(fresh.startedAt).not.toEqual(old.startedAt);
  });
  it('NX失败后记录消失不返回不存在的会话', async () => {
    const service = new GroupSessionService({ create: async () => false, get: async () => null, delete: async () => false });
    await expect(service.start(7, 'video', { id: 1, socketId: 'socket' })).rejects.toThrow('GROUP_SESSION_CHANGED');
  });
});
