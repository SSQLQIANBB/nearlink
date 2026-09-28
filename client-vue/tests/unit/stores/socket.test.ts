import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  options: null as any,
}));

vi.mock('socket.io-client', () => ({
  io: (_url: string, options: any) => {
    mock.options = options;
    return {
      id: 'self-socket', connected: true,
      on: (event: string, handler: Function) => mock.handlers.set(event, handler),
      off: (event: string) => mock.handlers.delete(event),
      connect: vi.fn(), disconnect: vi.fn(), emit: vi.fn(),
    };
  },
}));

import { useSocketStore } from '../../../src/stores/socket';

beforeEach(() => {
  setActivePinia(createPinia());
  mock.handlers.clear();
  mock.options = null;
});

describe('在线联系人同步', () => {
  it('连接优先使用 WebSocket，快照后正确应用上下线和状态增量', () => {
    const store = useSocketStore();
    store.connect('token', { id: 1, username: 'me' });
    expect(mock.options.transports).toEqual(['websocket', 'polling']);
    expect(mock.options.tryAllTransports).toBe(true);

    mock.handlers.get('authenticated')!();
    mock.handlers.get('user_list')!([
      { id: 1, socketId: 'self-socket', username: 'me', status: 'online' },
      { id: 2, socketId: 'other-socket', username: 'alice', status: 'online' },
    ]);
    expect(store.userList.map(user => user.id)).toEqual([2]);

    mock.handlers.get('user_presence')!({ userId: 2, user: {
      id: 2, socketId: 'other-socket', username: 'alice', status: 'busy',
    } });
    expect(store.userList[0]?.status).toBe('busy');

    mock.handlers.get('user_presence')!({ userId: 2 });
    expect(store.userList).toEqual([]);
    mock.handlers.get('user_presence')!({ userId: 1, user: {
      id: 1, socketId: 'self-socket', username: 'me', status: 'online',
    } });
    expect(store.userList).toEqual([]);
  });
});

describe('群组撤销订阅', () => {
  it('已退群的订阅不在后续认证时自动恢复', async () => {
    const { groupSessionState } = await import('../../../src/services/groupSessionState');
    const store = useSocketStore();
    store.connect('token', { id: 1, username: 'me' });
    mock.handlers.get('authenticated')!();
    store.setSubscribedGroups([7, 8]);
    groupSessionState.applyStarted({ groupId: 7, type: 'video', channelId: 'group:7:video', ownerUserId: 1, ownerSocketId: 's', startedAt: 'now' });
    mock.handlers.get('group_access_revoked')!({ groupId: 7 });
    expect(groupSessionState.getSession(7, 'video')).toBeNull();
    vi.mocked(store.socket!.emit).mockClear();
    mock.handlers.get('authenticated')!();
    expect(store.socket!.emit).not.toHaveBeenCalledWith('join_group', { groupId: 7 });
    expect(store.socket!.emit).toHaveBeenCalledWith('join_group', { groupId: 8 });
    store.disconnect();
  });
});
