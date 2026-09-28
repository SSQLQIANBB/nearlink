import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  connection: null as null | ((socket: any) => void),
  broadcasts: [] as { rooms: string[]; event: string; payload: any }[],
  members: vi.fn(),
  member: vi.fn(),
  groupRevocationListeners: new Set<Function>(),
  start: vi.fn(),
  get: vi.fn(),
  end: vi.fn(),
  messageCreate: vi.fn(),
  groupMessageCreate: vi.fn(),
  session: null as any,
  validateSession: vi.fn(),
  findUser: vi.fn(),
  revocationListeners: new Set<Function>(),
}));
vi.mock('socket.io', () => ({ Server: class {
  on(_event: string, callback: (socket: any) => void) { mock.connection = callback; }
  emit(event: string, payload: any) { mock.broadcasts.push({ rooms: [], event, payload }); }
  to(rooms: string | string[]) { return { emit: (event: string, payload: any) => mock.broadcasts.push({ rooms: Array.isArray(rooms) ? rooms : [rooms], event, payload }) }; }
} }));
vi.mock('../../../src/services/groupAccessCoordinator', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/services/groupAccessCoordinator')>();
  return { ...actual, onGroupAccessRevoked: (listener: Function) => {
    mock.groupRevocationListeners.add(listener); return () => mock.groupRevocationListeners.delete(listener);
  } };
});
vi.mock('../../../src/utils/jwt', () => ({ verifyToken: (token: string) => ({ userId: Number(token), username: `user${token}` }) }));
vi.mock('../../../src/services/loginSessionService', () => ({
  validateAuthenticatedSession: mock.validateSession,
  onLoginSessionsRevoked: (listener: Function) => { mock.revocationListeners.add(listener); return () => mock.revocationListeners.delete(listener); },
}));
vi.mock('../../../src/models', () => ({
  GroupMember: { findAll: mock.members, findOne: mock.member },
  User: { findByPk: mock.findUser, update: vi.fn() },
  GroupMessage: { create: mock.groupMessageCreate },
  Message: { create: mock.messageCreate },
}));
vi.mock('../../../src/services/groupSessionService', () => ({ GroupSessionService: class {
  start = mock.start;
  get = mock.get;
  end = mock.end;
  async getGroupState() { return { video: null, audio: null, screen: null }; }
} }));
vi.mock('../../../src/services/redisGroupSessionStore', () => ({ RedisGroupSessionStore: class {} }));
vi.mock('../../../src/services/redisScreenAnnotationStore', () => ({ RedisScreenAnnotationStore: class {} }));
import initialMeeting from '../../../src/config/meeting';

function connect(id: number) {
  const handlers = new Map<string, Function>();
  const socket = {
    use: vi.fn(), disconnect: vi.fn(),
    id: `socket-${id}`, on: (event: string, handler: Function) => handlers.set(event, handler),
    emit: vi.fn(), join: vi.fn(), leave: vi.fn(), connected: true,
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: any) => mock.broadcasts.push({
        rooms: Array.isArray(rooms) ? rooms : [rooms],
        event,
        payload,
      }),
    }),
  };
  mock.connection!(socket);
  return { socket, handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.revocationListeners.clear();
  mock.groupRevocationListeners.clear();
  mock.session = null;
  mock.member.mockImplementation(async ({ where }) => where.userId === 3 ? null : ({
    userId: where.userId, groupId: where.groupId, role: [1, 11].includes(where.userId) ? 'owner' : 'member',
    canSpeak: true, update: vi.fn(),
  }));
  mock.findUser.mockResolvedValue({ status: 'online' });
  mock.validateSession.mockImplementation(async (token: string) => ({ userId: Number(token), username: `user${token}`, sid: `sid-${token}`, authVersion: 'v1', exp: 9_999_999_999 }));
  mock.broadcasts.length = 0;
  mock.members.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
  mock.start.mockImplementation(async (groupId, type, owner) => {
    mock.session = {
      groupId,
      type,
      channelId: `group:${groupId}:${type}`,
      ownerUserId: owner.id,
      ownerSocketId: owner.socketId,
      startedAt: new Date(10_000).toISOString(),
    };
    return { created: true, session: mock.session };
  });
  mock.get.mockImplementation(async () => mock.session);
  mock.end.mockResolvedValue(true);
  mock.messageCreate.mockImplementation(async input => ({
    id: 99,
    ...input,
    createdAt: new Date('2026-09-17T12:00:00Z'),
    toJSON: () => ({ id: 99, ...input, createdAt: '2026-09-17T12:00:00.000Z' }),
  }));
  mock.groupMessageCreate.mockImplementation(async input => ({
    id: 100,
    ...input,
    createdAt: new Date('2026-09-17T12:00:00Z'),
    toJSON: () => ({ id: 100, ...input, createdAt: '2026-09-17T12:00:00.000Z' }),
  }));
});

afterEach(() => vi.useRealTimers());

describe('长连接登录会话撤销', () => {
  it('迟到的账号撤销事件保留事务提交后创建的新版本连接', async () => {
    initialMeeting({} as any);
    const oldLogin = connect(1);
    await oldLogin.handlers.get('authenticate')!({ token: '1' });
    mock.validateSession.mockResolvedValueOnce({ userId: 1, username: 'user1', sid: 'new-sid', authVersion: 'v2', exp: 9_999_999_999 });
    const newLogin = connect(1);
    await newLogin.handlers.get('authenticate')!({ token: 'new-token' });
    for (const listener of mock.revocationListeners) listener({ userId: 1, revokedAuthVersion: 'v1', currentAuthVersion: 'v2' });
    expect(oldLogin.socket.disconnect).toHaveBeenCalledWith(true);
    expect(newLogin.socket.disconnect).not.toHaveBeenCalled();
  });
  it('连续改密事件乱序时只断开各自撤销的版本', async () => {
    initialMeeting({} as any);
    mock.validateSession.mockResolvedValueOnce({ userId: 1, username: 'user1', sid: 'latest-sid', authVersion: 'v3', exp: 9_999_999_999 });
    const latest = connect(1);
    await latest.handlers.get('authenticate')!({ token: 'latest-token' });
    for (const event of [{ userId: 1, revokedAuthVersion: 'v2', currentAuthVersion: 'v3' },
      { userId: 1, revokedAuthVersion: 'v1', currentAuthVersion: 'v2' }]) {
      for (const listener of mock.revocationListeners) listener(event);
    }
    expect(latest.socket.disconnect).not.toHaveBeenCalled();
  });
  it('空闲Socket到期后断开，不能继续被动接收房间消息', async () => {
    vi.useFakeTimers();
    mock.validateSession.mockResolvedValueOnce({ userId: 1, username: 'user1', sid: 'sid-1', authVersion: 'v1', exp: Math.floor(Date.now() / 1000) + 1 });
    initialMeeting({} as any);
    const alice = connect(1);
    await alice.handlers.get('authenticate')!({ token: '1' });
    await vi.advanceTimersByTimeAsync(1001);
    expect(alice.socket.disconnect).toHaveBeenCalledWith(true);
  });
  it('读取账号资料期间收到撤销，不得补发authenticated或恢复旧连接', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    let finishProfile!: (value: unknown) => void;
    mock.findUser.mockImplementationOnce(() => new Promise(resolve => { finishProfile = resolve; }));
    const authenticating = alice.handlers.get('authenticate')!({ token: '1' });
    await Promise.resolve();
    for (const listener of mock.revocationListeners) listener({ userId: 1, sid: 'sid-1' });
    finishProfile({ status: 'online' });
    await authenticating;
    expect(alice.socket.disconnect).toHaveBeenCalledWith(true);
    expect(alice.socket.emit.mock.calls.some(([event]) => event === 'authenticated')).toBe(false);
  });
  it('每个后续事件重新验证sid，撤销后即使Socket存活也不能继续发送', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    await alice.handlers.get('authenticate')!({ token: '1' });
    const middleware = alice.socket.use.mock.calls[0][0];
    const allowed = vi.fn();
    await middleware(['private_message'], allowed);
    expect(allowed).toHaveBeenCalledWith();
    mock.validateSession.mockRejectedValueOnce(new Error('revoked'));
    const denied = vi.fn();
    await middleware(['private_message'], denied);
    expect(denied.mock.calls[0][0]).toEqual(new Error('AUTH_REVOKED'));
    expect(alice.socket.disconnect).toHaveBeenCalledWith(true);
  });
  it('同一sid换新token时，已在途验证的事件不会错误断开新认证', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    await alice.handlers.get('authenticate')!({ token: '1' });
    const payload = { userId: 1, username: 'user1', sid: 'sid-1', authVersion: 'v1', exp: 9_999_999_999 };
    let finishValidation!: (value: typeof payload) => void;
    mock.validateSession.mockImplementationOnce(() => new Promise(resolve => { finishValidation = resolve; }));
    const next = vi.fn();
    const validating = alice.socket.use.mock.calls[0][0](['private_message'], next);
    mock.validateSession.mockResolvedValueOnce(payload);
    await alice.handlers.get('authenticate')!({ token: 'refreshed-token' });
    finishValidation(payload);
    await validating;
    expect(next).toHaveBeenCalledWith();
    expect(alice.socket.disconnect).not.toHaveBeenCalled();
  });
  it('只断开匹配sid，账号级撤销则断开该账号所有连接', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    await alice.handlers.get('authenticate')!({ token: '1' });
    for (const listener of mock.revocationListeners) listener({ userId: 1, sid: 'other-sid' });
    expect(alice.socket.disconnect).not.toHaveBeenCalled();
    for (const listener of mock.revocationListeners) listener({ userId: 1 });
    expect(alice.socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('私聊通话历史', () => {
  it('被叫断开时通知主叫结束等待，并拒绝已结束呼叫的铃声回传', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    const bob = connect(2);
    await alice.handlers.get('authenticate')!({ token: '1' });
    await bob.handlers.get('authenticate')!({ token: '2' });
    alice.handlers.get('webrtc_call_request')!({ to: { socketId: 'socket-2' }, deviceType: 2, callId: 'call-1' });
    await bob.handlers.get('disconnect')!();
    expect(mock.broadcasts).toContainEqual({ rooms: ['socket-1'], event: 'webrtc_hangup', payload: { from: 'socket-2' } });
    bob.handlers.get('webrtc_call_ringing')!({ to: { socketId: 'socket-1' }, callId: 'call-1', tone: 'classic' });
    expect(mock.broadcasts.filter(item => item.event === 'webrtc_call_ringing')).toHaveLength(0);
  });
  it('仅转发当前未接受呼叫的被叫铃声，拒绝伪造及过期回传', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    const bob = connect(2);
    const other = connect(3);
    await alice.handlers.get('authenticate')!({ token: '1' });
    await bob.handlers.get('authenticate')!({ token: '2' });
    await other.handlers.get('authenticate')!({ token: '3' });
    alice.handlers.get('webrtc_call_request')!({ to: { socketId: 'socket-2' }, deviceType: 2, callId: 'call-1' });
    const ringing = { to: { socketId: 'socket-1' }, callId: 'call-1', tone: 'classic' };
    other.handlers.get('webrtc_call_ringing')!(ringing);
    bob.handlers.get('webrtc_call_ringing')!({ ...ringing, callId: 'stale' });
    bob.handlers.get('webrtc_call_ringing')!({ ...ringing, tone: 'https://untrusted.test/audio' });
    expect(mock.broadcasts.filter(item => item.event === 'webrtc_call_ringing')).toHaveLength(0);
    bob.handlers.get('webrtc_call_ringing')!(ringing);
    expect(mock.broadcasts.filter(item => item.event === 'webrtc_call_ringing')).toEqual([
      { rooms: ['socket-1'], event: 'webrtc_call_ringing', payload: { from: 'socket-2', callId: 'call-1', tone: 'classic' } },
    ]);
    await bob.handlers.get('webrtc_call_response')!({ to: { socketId: 'socket-1' }, accepted: true });
    bob.handlers.get('webrtc_call_ringing')!(ringing);
    expect(mock.broadcasts.filter(item => item.event === 'webrtc_call_ringing')).toHaveLength(1);
  });
  it('从双方实际接通开始计时，并在挂断后同步给双方', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    const bob = connect(2);
    await alice.handlers.get('authenticate')!({ token: '1' });
    await bob.handlers.get('authenticate')!({ token: '2' });

    alice.handlers.get('webrtc_call_request')!({ to: { socketId: 'socket-2' }, deviceType: 0 });
    await bob.handlers.get('webrtc_call_response')!({ to: { socketId: 'socket-1' }, accepted: true });

    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    alice.handlers.get('webrtc_call_connected')!({ to: { socketId: 'socket-2' } });
    now.mockReturnValue(75_000);
    await bob.handlers.get('webrtc_hangup')!({ to: { socketId: 'socket-1' } });
    now.mockRestore();

    expect(mock.messageCreate).toHaveBeenCalledWith(expect.objectContaining({
      fromUserId: 1,
      toUserId: 2,
      message: '__TODESK_CALL_HISTORY__:{"type":"video","status":"completed","durationSeconds":65}',
      isRead: true,
    }));
    expect(mock.broadcasts).toContainEqual({
      rooms: ['socket-1', 'socket-2'],
      event: 'private_call_history',
      payload: expect.objectContaining({
        id: 99,
        message: '[视频通话] 通话时长 01:05',
        messageType: 'call',
        call: { type: 'video', status: 'completed', durationSeconds: 65 },
      }),
    });
  });
});

describe('群组通话邀请时序', () => {
  it('创建尚未完成时挂断，不再向群成员广播邀请', async () => {
    initialMeeting({} as any);
    const alice = connect(1);
    await alice.handlers.get('authenticate')!({ token: '1' });
    const session = {
      groupId: 7,
      type: 'video',
      channelId: 'group:7:video',
      ownerUserId: 1,
      ownerSocketId: 'socket-1',
      startedAt: new Date(10_000).toISOString(),
    };
    let finishStart!: (value: { created: true; session: typeof session }) => void;
    mock.start.mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve; }));
    mock.get.mockResolvedValueOnce(null);

    const starting = alice.handlers.get('group_call_start')!({ groupId: 7, deviceType: 1 });
    await vi.waitFor(() => expect(mock.start).toHaveBeenCalled());
    const ending = alice.handlers.get('group_call_end')!({ groupId: 7, deviceType: 1 });
    finishStart({ created: true, session });
    await Promise.all([starting, ending]);

    expect(mock.broadcasts.some(item => item.event === 'group_call_started')).toBe(false);
  });
});

describe('群组邀请发送范围', () => {
  it.each([1, 2])('deviceType=%s 时未加入群组 Socket 房间的在线成员也收到邀请', async deviceType => {
    initialMeeting({} as any);
    const alice = connect(1);
    const bob = connect(2);
    const outsider = connect(3);
    await alice.handlers.get('authenticate')!({ token: '1' });
    await bob.handlers.get('authenticate')!({ token: '2' });
    await outsider.handlers.get('authenticate')!({ token: '3' });
    await alice.handlers.get('group_call_start')!({ groupId: 7, deviceType });
    expect(bob.socket.join).not.toHaveBeenCalled();
    expect(mock.members).toHaveBeenCalledWith({ where: { groupId: 7 } });
    expect(mock.broadcasts).toContainEqual({
      rooms: ['socket-1', 'socket-2'], event: 'group_call_started',
      payload: expect.objectContaining({ groupId: 7, deviceType }),
    });
    expect(mock.broadcasts.find(item => item.event === 'group_call_started')!.rooms).not.toContain('socket-3');
  });
});

describe('群组通话历史', () => {
  it('群组视频结束后保存发起人和会话时长', async () => {
    initialMeeting({} as any);
    const alice = connect(11);
    await alice.handlers.get('authenticate')!({ token: '11' });
    await alice.handlers.get('group_call_start')!({ groupId: 7, deviceType: 1 });

    const now = vi.spyOn(Date, 'now').mockReturnValue(75_000);
    await alice.handlers.get('group_call_end')!({ groupId: 7, deviceType: 1 });
    now.mockRestore();

    expect(mock.groupMessageCreate).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 7,
      userId: 11,
      message: '__TODESK_CALL_HISTORY__:{"type":"video","status":"completed","durationSeconds":65}',
      messageType: 'system',
    }));
    expect(mock.broadcasts).toContainEqual({
      rooms: ['group_7'],
      event: 'group_message',
      payload: expect.objectContaining({
        id: 100,
        message: '[视频通话] 通话时长 01:05',
        messageType: 'call',
        call: { type: 'video', status: 'completed', durationSeconds: 65 },
      }),
    });
  });
});

describe('在线状态增量同步', () => {
  it('只向新连接发送全量快照，后续只广播变化', async () => {
    initialMeeting({} as any);
    const alice = connect(101);
    const bob = connect(102);
    await alice.handlers.get('authenticate')!({ token: '101' });
    await bob.handlers.get('authenticate')!({ token: '102' });

    expect(bob.socket.emit).toHaveBeenCalledWith('user_list', expect.arrayContaining([
      expect.objectContaining({ id: 101 }), expect.objectContaining({ id: 102 }),
    ]));
    expect(mock.broadcasts.filter(item => item.event === 'user_list')).toHaveLength(0);
    expect(mock.broadcasts.filter(item => item.event === 'user_presence')).toHaveLength(2);

    await bob.handlers.get('status_update')!({ status: 'busy' });
    await bob.handlers.get('status_update')!({ status: 'busy' });
    expect(mock.broadcasts.filter(item => item.event === 'user_presence' && item.payload.userId === 102)).toHaveLength(2);

    await bob.handlers.get('disconnect')!();
    expect(mock.broadcasts.at(-1)).toEqual({ rooms: [], event: 'user_presence', payload: { userId: 102 } });
  });

  it('同一用户的一个设备断开后仍显示另一个在线设备', async () => {
    initialMeeting({} as any);
    const first = connect(103);
    const second = connect(104);
    await first.handlers.get('authenticate')!({ token: '103' });
    await second.handlers.get('authenticate')!({ token: '103' });
    await second.handlers.get('disconnect')!();

    expect(mock.broadcasts.at(-1)).toEqual({
      rooms: [], event: 'user_presence',
      payload: { userId: 103, user: expect.objectContaining({ socketId: 'socket-103' }) },
    });
  });
});

describe('群组访问与媒体隔离', () => {
  async function member(id: number, token = String(id)) {
    const client = connect(id);
    await client.handlers.get('authenticate')!({ token });
    return client;
  }
  async function room() {
    initialMeeting({} as any);
    const alice = await member(1);
    const bob = await member(2);
    await alice.handlers.get('group_call_start')!({ groupId: 7, deviceType: 1 });
    const join = { groupId: 7, deviceType: 1, startedAt: mock.session.startedAt };
    await alice.handlers.get('join_group_call')!(join);
    await bob.handlers.get('join_group_call')!(join);
    mock.broadcasts.length = 0;
    return { alice, bob, join };
  }
  it.each(['join_group', 'group_call_start', 'join_group_call', 'screen_annotation_clear'])('%s 拒绝非成员，不能订阅、建会或读取标注', async event => {
    initialMeeting({} as any);
    const outsider = await member(3);
    await outsider.handlers.get(event)!({ groupId: 7, deviceType: 1 });
    expect(outsider.socket.join).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.get).not.toHaveBeenCalled();
    expect(outsider.socket.emit).toHaveBeenCalledWith('group_call_error', expect.objectContaining({ code: 'GROUP_ACCESS_DENIED' }));
  });
  it('权限查询失败时关闭准入，不默认允许加入', async () => {
    initialMeeting({} as any);
    const alice = await member(1);
    mock.member.mockRejectedValueOnce(new Error('database unavailable'));
    await alice.handlers.get('join_group')!({ groupId: 7 });
    expect(alice.socket.join).not.toHaveBeenCalled();
    expect(alice.socket.emit).toHaveBeenCalledWith('group_call_error', expect.objectContaining({ code: 'GROUP_SERVICE_UNAVAILABLE' }));
  });
  it.each([null, {}, { groupId: -1 }, { groupId: '7' }, { groupId: 7, deviceType: 99 }])('无效载荷 %j 不访问数据库或建立会话', async input => {
    initialMeeting({} as any);
    const alice = await member(1);
    await alice.handlers.get('group_call_start')!(input);
    expect(mock.member).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
  });
  it.each(['group_webrtc_offer', 'group_webrtc_answer', 'group_webrtc_ice'])('%s 只转发同群同场已入会的真实Socket', async event => {
    const { alice, bob, join } = await room();
    const payload = { ...join, to: bob.socket.id, offer: { sdp: 'test' }, answer: {}, candidate: {} };
    await alice.handlers.get(event)!(payload);
    expect(mock.broadcasts.filter(item => item.event === event)).toHaveLength(1);
    await alice.handlers.get(event)!({ ...payload, to: 'group_7' });
    await alice.handlers.get(event)!({ ...payload, groupId: 8 });
    await alice.handlers.get(event)!({ ...payload, startedAt: 'old-session' });
    await alice.handlers.get(event)!({ ...payload, startedAt: undefined });
    await bob.handlers.get('leave_group_call')!(join);
    await alice.handlers.get(event)!(payload);
    expect(mock.broadcasts.filter(item => item.event === event)).toHaveLength(1);
  });
  it('群成员未进入媒体会话时也不能发起群信令', async () => {
    const { alice, join } = await room();
    const observer = await member(4);
    await observer.handlers.get('group_webrtc_offer')!({ ...join, to: alice.socket.id, offer: {} });
    expect(mock.broadcasts.some(item => item.event === 'group_webrtc_offer')).toBe(false);
  });
  it('接收者成员资格再次检查，已离群但尚有旧映射也收不到信令', async () => {
    const { alice, bob, join } = await room();
    mock.member.mockImplementation(async ({ where }) => where.userId === 2 ? null : ({ role: 'owner' }));
    await alice.handlers.get('group_webrtc_offer')!({ ...join, to: bob.socket.id, offer: {} });
    expect(mock.broadcasts.some(item => item.event === 'group_webrtc_offer')).toBe(false);
  });
  it('退出群组撤销所有登录设备的房间订阅，通知其余参与者断开Peer', async () => {
    const { alice, bob, join } = await room();
    const bobSecond = await member(22, '2');
    await bobSecond.handlers.get('join_group_call')!(join);
    await bob.handlers.get('join_group')!({ groupId: 7 });
    for (const listener of mock.groupRevocationListeners) await listener({ groupId: 7, userId: 2, reason: 'left' });
    for (const client of [bob, bobSecond]) {
      expect(client.socket.leave).toHaveBeenCalledWith('group_7');
      expect(client.socket.leave).toHaveBeenCalledWith('group:7:video');
      expect(client.socket.emit).toHaveBeenCalledWith('group_access_revoked', { groupId: 7 });
    }
    expect(mock.broadcasts.filter(item => item.event === 'group_call_member_left').map(item => item.payload.socketId))
      .toEqual(expect.arrayContaining(['socket-2', 'socket-22']));
    mock.broadcasts.length = 0;
    await alice.handlers.get('group_webrtc_offer')!({ ...join, to: bob.socket.id, offer: {} });
    expect(mock.broadcasts.some(item => item.event === 'group_webrtc_offer')).toBe(false);
  });
  it('群删除立即移除房间和媒体，即使后续Redis清理失败', async () => {
    const { alice, bob } = await room();
    mock.end.mockRejectedValueOnce(new Error('Redis down'));
    await Promise.allSettled([...mock.groupRevocationListeners].map(listener => listener({ groupId: 7, reason: 'deleted' })));
    expect(bob.socket.leave).toHaveBeenCalledWith('group:7:video');
    expect(alice.socket.emit).toHaveBeenCalledWith('group_access_revoked', { groupId: 7 });
    expect(bob.socket.emit).toHaveBeenCalledWith('group_access_revoked', { groupId: 7 });
    expect(mock.broadcasts.some(item => item.event === 'group_call_ended')).toBe(true);
  });
  it('成员不能伪造群主麦克风控制，群主操作须持久化且通知目标全部设备', async () => {
    const { alice, bob } = await room();
    const update = vi.fn().mockResolvedValue(undefined);
    mock.member.mockImplementation(async ({ where }) => ({ role: where.userId === 1 ? 'owner' : 'member', update }));
    await bob.handlers.get('control_member_mic')!({ groupId: 7, targetSocketId: alice.socket.id, canSpeak: false });
    expect(update).not.toHaveBeenCalled();
    expect(mock.broadcasts.some(item => item.event === 'mic_permission_changed')).toBe(false);
    await alice.handlers.get('control_member_mic')!({ groupId: 7, targetSocketId: bob.socket.id, canSpeak: false });
    expect(update).toHaveBeenCalledWith({ canSpeak: false });
    expect(mock.broadcasts).toContainEqual({ rooms: ['socket-2'], event: 'mic_permission_changed', payload: { groupId: 7, canSpeak: false } });
  });
  it('同账号另一个Socket不能结束原发起Socket的会话', async () => {
    const { alice } = await room();
    const another = await member(10, '1');
    mock.end.mockClear();
    await another.handlers.get('group_call_end')!({ groupId: 7, deviceType: 1 });
    expect(mock.end).not.toHaveBeenCalled();
    await alice.handlers.get('group_call_end')!({ groupId: 7, deviceType: 1 });
    expect(mock.end).toHaveBeenCalledWith(7, 'video', 1, expect.objectContaining({ ownerSocketId: 'socket-1' }));
  });
  it('读取会话期间断开连接，不恢复房间订阅', async () => {
    initialMeeting({} as any);
    const alice = await member(1);
    let complete!: (value: unknown) => void;
    mock.member.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const joining = alice.handlers.get('join_group')!({ groupId: 7 });
    await vi.waitFor(() => expect(mock.member).toHaveBeenCalled());
    await alice.handlers.get('disconnect')!();
    complete({ role: 'owner' });
    await joining;
    expect(alice.socket.join).not.toHaveBeenCalled();
  });
});
