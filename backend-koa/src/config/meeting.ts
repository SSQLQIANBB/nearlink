import {
  accessibleMessage, // 校验当前用户是否有权访问某条消息（存在性、私聊参与人/群成员资格及当前用户的删除记录）
  attachQuote, // 将引用消息编码进正文，引用前校验同一会话
  deleteMessages, // 仅对当前用户隐藏消息：写入 message_deletions，不删除原消息
  type MessageReference, // 引用/转发的消息标识（kind + id）
} from '../services/messageActions';
import {
  resolveScreenScope, // 将屏幕共享范围解析为 MediaScopeId（数字 groupId 或私聊字符串）
  privateScreenMembers, // 获取私聊屏幕共享的双方 userId
  screenShareActions, // 屏幕共享 action → socket 事件名映射
  type MediaScopeId, // 群聊用 number，私聊屏幕共享用 string
  type ScreenShareScope, // 屏幕共享作用域（群组或私聊）
} from '../services/screenShareScope';
import { type Server } from 'http';
import { onGroupAccessRevoked, runGroupOperation } from '../services/groupAccessCoordinator';
import { Server as Socket } from 'socket.io';
import {
  onLoginSessionsRevoked, // 订阅单次退出登录、全端下线及修改密码产生的会话撤销事件
  validateAuthenticatedSession, // 验证 JWT 登录会话是否有效且未撤销
  type AuthenticatedSessionPayload, // JWT 载荷中的认证字段（userId, sid, authVersion）
} from '../services/loginSessionService';
import { File, GroupMember, GroupMessage, Message, User as UserModel } from '../models';
import { saveReliableMessage } from '../services/reliableMessageService'; // 提供 clientMessageId 时按 userId + kind + clientMessageId 去重，并校验目标与内容哈希一致
import {
  GroupSessionService, // 群媒体及私聊屏幕共享会话管理（存储由构造参数注入）
  type GroupSession, // 一次媒体会话（视频/语音/屏幕）的快照
  type GroupSessionType, // 'video' | 'audio' | 'screen'
} from '../services/groupSessionService';
import { MediaRoomRegistry } from '../services/mediaRoomRegistry'; // 媒体房间注册表：channelId → socketIds
import { RedisGroupSessionStore } from '../services/redisGroupSessionStore'; // 群媒体及私聊屏幕共享会话的 Redis 存储（12 小时 TTL）
import { RedisScreenAnnotationStore } from '../services/redisScreenAnnotationStore'; // 屏幕标注的 Redis 存储（写入时设置 12 小时 TTL）
import {
  ScreenAnnotationService, // 屏幕共享中的画笔标注服务
  type AnnotationAction, // 一条已完成的标注
  type AnnotationDraft, // 客户端发来的标注草稿（待校验）
} from '../services/screenAnnotationService';
import {
  createCallHistoryMessage, // 将通话记录序列化为消息内容
  PrivateCallTracker, // 私聊通话状态追踪（请求/接听/接通/挂断）
  serializeChatMessage, // 将 DB 消息记录转为客户端推送格式
  type CallHistoryType, // 'video' | 'screen' | 'audio'
  type PrivateCallHistoryRecord, // 一次私聊通话的历史记录
} from '../services/callHistoryService';
import { createChatMediaMessage, type ChatMediaMessage } from '../services/chatMediaMessageService';

type PresenceStatus = 'online' | 'offline' | 'busy';

// 校验画质参数是否为合法值
function isScreenQuality(value: unknown): value is 'low' | 'medium' | 'high' | 'ultra' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';
}

// 在线用户的内存表示（与 DB 的 User 模型区分，包含连接标识、展示资料和在线状态）
type MeetingUser = {
  id: number;
  socketId: string;
  username: string;
  nickname?: string;
  avatar?: string;
  status: PresenceStatus;
  bio?: string;
};

// 群聊设备类型编号：1=视频, 2=屏幕, 3=语音
function getSessionType(deviceType: number): GroupSessionType {
  if (deviceType === 3) return 'audio';
  return deviceType === 2 ? 'screen' : 'video';
}

// 群聊设备类型编号的反向映射（用于回传给客户端）
function getSessionDeviceType(type: GroupSessionType) {
  if (type === 'screen') return 2;
  return type === 'audio' ? 3 : 1;
}

// 私聊设备类型编号（与群聊编号不同）：0=视频, 1=屏幕, 2=语音
function getPrivateCallType(deviceType: number): CallHistoryType | null {
  if (deviceType === 0) return 'video';
  if (deviceType === 1) return 'screen';
  if (deviceType === 2) return 'audio';
  return null;
}

// 根据客户端消息数据解析最终的消息正文：
// - 转发 → 取原始消息内容
// - 图片/语音 → 校验文件归属后构造媒体消息
// - 普通文本 → 校验长度和格式
async function getMessageContent(
  data: {
    message?: string;
    messageType?: string;
    media?: ChatMediaMessage['media'];
    forward?: MessageReference;
  },
  userId: number,
  groupId?: number,
) {
  if (data.forward) return (await accessibleMessage(userId, data.forward)).message;
  if (data.messageType === 'image' || data.messageType === 'voice') {
    const fileId = data.media?.fileId;
    if (!Number.isSafeInteger(fileId)) throw new Error('媒体文件无效');

    const file = await File.findOne({ where: { id: fileId, userId } });
    const belongsToTarget =
      groupId === undefined ? file?.groupId == null : Number(file?.groupId) === groupId;
    if (!file || !belongsToTarget) throw new Error('媒体文件无效');

    return createChatMediaMessage({
      type: data.messageType,
      media: { ...data.media, url: file.fileUrl },
    });
  }
  const message = data.message?.trim();
  if (message?.startsWith('__NEARLINK_REPLY__:')) throw new Error('消息格式无效');
  if (!message || message.length > 10000) throw new Error('消息无效');
  return message;
}

// 初始化 Socket.IO 实时通信服务，挂载路径 /meeting
// 管理：用户认证、在线状态、私聊消息、群聊消息、群媒体会话（视频/语音/屏幕）、私聊通话、屏幕标注
const initialMeeting = (server: Server) => {
  const io = new Socket(server, {
    path: '/meeting',
    cors: {
      origin: '*',
    },
  });

  // socketId → 用户信息（每个已认证的 socket 对应一个 MeetingUser）
  const userMap = new Map<string, MeetingUser>();
  // socketId → userId（反查：一个用户可能有多台设备/多个 socket）
  const socketToUserMap = new Map<string, number>();
  // groupId → 已订阅群聊房间的 socketId 集合，用于成员快照和退出清理；不代表数据库中的全部群成员
  const groupRooms = new Map<number, Set<string>>();
  // 媒体房间注册表：按 channelId 记录参与者的 socketId 和 userId
  const mediaRooms = new MediaRoomRegistry();
  // 与进程内媒体连接同生命周期；加入者领取快照，切换时向当前房间广播。
  const screenQualities = new Map<
    string,
    { groupId: MediaScopeId; startedAt: string; quality: string }
  >();
  // 对方通过加入请求的会话校验后记录 channelId:startedAt，用于通话历史判定；不代表 WebRTC 已连通
  const connectedPrivateScreens = new Set<string>();
  // 私聊屏幕共享中每个成员的麦克风权限：channelId → userId → canSpeak
  const privateMicPermissions = new Map<string, Map<number, boolean>>();
  // 群媒体及私聊屏幕共享会话服务（此处使用 Redis 存储）
  const groupSessionService = new GroupSessionService(new RedisGroupSessionStore());
  // 屏幕标注服务（底层存 Redis）
  const screenAnnotationService = new ScreenAnnotationService(new RedisScreenAnnotationStore());
  // 获取所有非 offline 状态的在线用户列表（去重：同一用户多设备只返回一条）
  function getPublicUsers() {
    const users = new Map<number, MeetingUser>();

    for (const user of userMap.values()) {
      if (user.status !== 'offline') {
        users.set(user.id, user);
      }
    }

    return [...users.values()];
  }

  // 按 userId 查找在线用户
  function getPublicUser(userId: number): MeetingUser | undefined {
    return getPublicUsers().find((user) => user.id === userId);
  }

  // 比较两个用户信息是否有变化（用于判断是否需要广播 presence 变更）
  function samePublicUser(left?: MeetingUser, right?: MeetingUser) {
    if (!left || !right) return left === right;
    return (
      left.socketId === right.socketId &&
      left.status === right.status &&
      left.username === right.username &&
      left.nickname === right.nickname &&
      left.avatar === right.avatar &&
      left.bio === right.bio
    );
  }

  // 获取用户已认证且未断开的 socketId，包含主动设置为 offline 的连接
  function getUserSockets(userId: number) {
    return [...socketToUserMap.entries()]
      .filter(([, mappedUserId]) => mappedUserId === userId)
      .map(([socketId]) => socketId);
  }

  // 每个 socket 加入的媒体会话：socketId → (channelId → GroupSession)
  const joinedBySocket = new Map<string, Map<string, GroupSession>>();
  // 所有活跃 socket 的引用（用于遍历、广播）
  const sockets = new Map<string, import('socket.io').Socket>();

  // 消息写入耗时采样（用于 P95 监控）
  const messageWriteMs: number[] = [];
  // 私聊通话状态追踪器
  const privateCallTracker = new PrivateCallTracker();
  // 当前周期内私聊/群聊发送处理捕获的异常次数，包含内容校验及保存失败（每分钟归零）
  let messageWriteFailures = 0;
  // 每 60s 输出一次实时通信监控指标
  const metricsTimer = setInterval(() => {
    const transports = { websocket: 0, polling: 0 };
    for (const client of io.sockets.sockets.values()) {
      if (client.conn.transport.name === 'websocket') transports.websocket++;
      else transports.polling++;
    }
    const latencies = messageWriteMs.splice(0).sort((a, b) => a - b);
    const p95 = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
    console.info(
      'realtime_metrics',
      JSON.stringify({
        connections: io.engine.clientsCount,
        transports,
        messageWrites: latencies.length,
        messageWriteP95Ms: p95,
        messageWriteFailures,
      }),
    );
    messageWriteFailures = 0;
  }, 60_000);
  metricsTimer.unref();
  server.once?.('close', () => clearInterval(metricsTimer));

  // 向群成员或私聊屏幕共享双方的已认证连接推送媒体会话事件
  async function emitGroupSessionEvent(
    groupId: MediaScopeId,
    event: string,
    payload: unknown,
    isCurrent?: () => boolean,
  ) {
    const members =
      typeof groupId === 'number'
        ? await GroupMember.findAll({ where: { groupId } })
        : privateScreenMembers(groupId).map((userId) => ({ userId }));
    if (isCurrent && !isCurrent()) return;
    const socketIds = members.flatMap((member) => getUserSockets(member.userId));
    if (socketIds.length) io.to(socketIds).emit(event, payload);
  }

  // 保存私聊通话历史到 Message 表，并推送 private_call_history 给双方
  async function savePrivateCallHistory(record: PrivateCallHistoryRecord) {
    const saved = await Message.create({
      fromUserId: record.callerUserId,
      toUserId: record.calleeUserId,
      message: createCallHistoryMessage(record),
      isRead: true,
    });
    const payload = serializeChatMessage(saved);
    const socketIds = [
      ...new Set([...getUserSockets(record.callerUserId), ...getUserSockets(record.calleeUserId)]),
    ];
    if (socketIds.length) io.to(socketIds).emit('private_call_history', payload);
  }

  // 保存媒体通话历史：私聊屏幕共享写入 Message；群视频、语音和屏幕共享写入 GroupMessage
  async function saveGroupCallHistory(session: GroupSession, user?: MeetingUser | null) {
    const durationSeconds = Math.max(
      1,
      Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000),
    );
    if (typeof session.groupId === 'string') {
      const peerId = privateScreenMembers(session.groupId).find(
        (id) => id !== session.ownerUserId,
      )!;
      const connected = connectedPrivateScreens.delete(`${session.channelId}:${session.startedAt}`);
      await savePrivateCallHistory({
        callerUserId: session.ownerUserId,
        calleeUserId: peerId,
        type: 'screen',
        status: connected ? 'completed' : 'cancelled',
        durationSeconds: connected ? durationSeconds : 0,
      });
      return;
    }
    const saved = await GroupMessage.create({
      groupId: session.groupId,
      userId: session.ownerUserId,
      message: createCallHistoryMessage({
        type: session.type,
        status: 'completed',
        durationSeconds,
      }),
      messageType: 'system',
    });
    io.to(`group_${session.groupId}`).emit('group_message', {
      ...serializeChatMessage(saved),
      groupId: session.groupId,
      userId: session.ownerUserId,
      user: user || getPublicUser(session.ownerUserId),
      time: saved.createdAt?.toLocaleString() || new Date().toLocaleString(),
      createdAt: saved.createdAt,
    });
  }

  // 记录私聊通话历史（容错：失败只记日志不抛出）
  async function recordPrivateCall(record: PrivateCallHistoryRecord | null) {
    if (!record) return;
    try {
      await savePrivateCallHistory(record);
    } catch (error) {
      console.error('save private call history failed:', error);
    }
  }

  // 记录群媒体或私聊屏幕共享历史，失败仅记录日志，不阻断调用方
  async function recordGroupCall(session: GroupSession, user?: MeetingUser | null) {
    try {
      await saveGroupCallHistory(session, user);
    } catch (error) {
      console.error('save group call history failed:', error);
    }
  }

  // 结束私聊屏幕共享会话：清理服务端媒体房间、通知客户端结束、清除标注并记录历史
  async function finishPrivateScreen(session: GroupSession, rejected = false) {
    if (!(await groupSessionService.end(session.groupId, 'screen', session.ownerUserId, session)))
      return;
    closeMediaSession(session);
    await screenAnnotationService.end(session);
    if (rejected) {
      connectedPrivateScreens.delete(`${session.channelId}:${session.startedAt}`);
      await recordPrivateCall({
        callerUserId: session.ownerUserId,
        calleeUserId: privateScreenMembers(session.groupId).find(
          (id) => id !== session.ownerUserId,
        )!,
        type: 'screen',
        status: 'rejected',
        durationSeconds: 0,
      });
    } else await recordGroupCall(session);
    await emitGroupSessionEvent(session.groupId, 'group_call_ended', {
      groupId: session.groupId,
      type: 'screen',
      deviceType: 2,
      startedAt: session.startedAt,
    });
  }

  // 向所有客户端广播用户在线状态变更（仅在信息实际变化时）
  function emitPresenceChange(userId: number, previous?: MeetingUser) {
    const next = getPublicUser(userId);
    if (samePublicUser(previous, next)) return;
    io.emit('user_presence', next ? { userId, user: next } : { userId });
  }

  // 向媒体房间广播当前参与成员列表
  function emitMediaPresence(session: GroupSession) {
    io.to(session.channelId).emit('group_call_presence', {
      groupId: session.groupId,
      type: session.type,
      channelId: session.channelId,
      startedAt: session.startedAt,
      userIds: mediaRooms.getUserIds(session.channelId),
    });
  }

  // 向群聊广播媒体房间已空（成员列表为空）
  function emitEmptyMediaPresence(session: GroupSession) {
    io.to(`group_${session.groupId}`).emit('group_call_presence', {
      groupId: session.groupId,
      type: session.type,
      channelId: session.channelId,
      startedAt: session.startedAt,
      userIds: [],
    });
  }

  // 将 socket 从媒体房间移除并广播成员离开
  function removeFromMediaRoom(socketId: string, session: GroupSession, userId?: number) {
    if (!mediaRooms.leave(session.channelId, socketId)) return;

    io.to(session.channelId).emit('group_call_member_left', {
      groupId: session.groupId,
      type: session.type,
      channelId: session.channelId,
      startedAt: session.startedAt,
      socketId,
      userId,
    });
    emitMediaPresence(session);
  }

  // 关闭媒体会话：清理画质/麦克风权限、通知剩余成员会话结束、释放房间资源
  function closeMediaSession(session: GroupSession) {
    if (screenQualities.get(session.channelId)?.startedAt === session.startedAt)
      screenQualities.delete(session.channelId);
    privateMicPermissions.delete(session.channelId);
    const peers = mediaRooms
      .getSocketIds(session.channelId)
      .filter(
        (peerId) =>
          joinedBySocket.get(peerId)?.get(session.channelId)?.startedAt === session.startedAt,
      );
    if (peers.length)
      io.to(peers).emit('group_call_ended', {
        groupId: session.groupId,
        type: session.type,
        deviceType: getSessionDeviceType(session.type),
        startedAt: session.startedAt,
      });
    for (const peerId of peers) {
      joinedBySocket.get(peerId)?.delete(session.channelId);
      mediaRooms.leave(session.channelId, peerId);
      sockets.get(peerId)?.leave(session.channelId);
    }
    if (!mediaRooms.getSocketIds(session.channelId).length) emitEmptyMediaPresence(session);
  }

  // Socket.IO 连接处理：每个新连接注册所有事件监听器
  io.on('connection', (socket) => {
    const socketId = socket.id;
    // 当前 socket 的用户信息（认证成功后赋值）
    let currentUser: MeetingUser | null = null;
    // 当前认证的会话载荷（JWT 解析结果）
    let currentAuth: AuthenticatedSessionPayload | null = null;
    // 最近认证通过的 token；后续业务事件仍需重新校验
    let currentToken: string | null = null;
    // 认证尝试计数器（递增后使旧的异步认证流程失效）
    let authenticationAttempt = 0;
    // token 过期定时器
    let authenticationExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    // 该 socket 加入的媒体会话：channelId → GroupSession
    const joinedMediaSessions = new Map<string, GroupSession>();
    // 该 socket 拥有的媒体会话（作为发起者）：channelId → GroupSession
    const ownedSessions = new Map<string, GroupSession>();
    // 媒体会话启动版本：scopeId:type → 递增计数，使已被结束或撤权操作取代的异步启动失效
    const groupCallStartGenerations = new Map<string, number>();

    joinedBySocket.set(socketId, joinedMediaSessions);
    sockets.set(socketId, socket);
    const connected = () => !!currentUser && !!currentToken && socket.connected !== false;
    const screenStartGenerations = new Map<MediaScopeId, number>();
    const mediaHandlers = new Map<
      string,
      (data: any, ack?: (result: unknown) => void, privateScope?: boolean) => Promise<void>
    >();
    // 注册群聊与媒体事件：校验参数和连接状态，并按作用域串行执行
    // 群聊查询成员资格，私聊屏幕共享构造角色与麦克风权限；启动/结束事件更新版本号供处理器检查
    function onGroup(
      event: string,
      handler: (
        data: any,
        member: Pick<GroupMember, 'role' | 'canSpeak'>,
        generation?: number,
        ack?: (result: unknown) => void,
      ) => unknown,
    ) {
      const receive = async (data: any, ack?: (result: unknown) => void, privateScope = false) => {
        if (
          !data ||
          (!privateScope && (!Number.isSafeInteger(data.groupId) || data.groupId <= 0)) ||
          !connected()
        ) {
          if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_ACCESS_DENIED' });
          return;
        }
        const types: GroupSessionType[] = ['video', 'audio', 'screen'];
        const requiresDeviceType = [
          'group_call_start',
          'join_group_call',
          'leave_group_call',
          'group_webrtc_offer',
          'group_webrtc_answer',
          'group_webrtc_ice',
        ].includes(event);
        if (
          (requiresDeviceType || data.deviceType !== undefined) &&
          ![1, 2, 3].includes(data.deviceType)
        )
          return;
        if (data.type !== undefined && !types.includes(data.type)) return;
        let generation: number | undefined;
        // Cancellation must invalidate a start even while its Redis write is pending.
        if (event === 'group_call_start' || event === 'group_call_end') {
          const affected =
            event === 'group_call_start'
              ? [getSessionType(data.deviceType)]
              : data.type
                ? [data.type]
                : data.deviceType
                  ? [getSessionType(data.deviceType)]
                  : types;
          for (const type of affected) {
            const key = `${data.groupId}:${type}`;
            generation = (groupCallStartGenerations.get(key) || 0) + 1;
            groupCallStartGenerations.set(key, generation);
          }
        }
        try {
          await runGroupOperation(data.groupId, async () => {
            if (!connected()) return;
            const privateSession = privateScope
              ? await groupSessionService.get(data.groupId, 'screen')
              : null;
            const member = privateScope
              ? {
                  role:
                    privateSession?.ownerUserId === currentUser!.id
                      ? ('owner' as const)
                      : ('member' as const),
                  canSpeak:
                    privateMicPermissions
                      .get(privateSession?.channelId || '')
                      ?.get(currentUser!.id) !== false,
                }
              : await GroupMember.findOne({
                  where: { groupId: data.groupId, userId: currentUser!.id },
                });
            if (!connected()) return;
            if (!member) {
              await revokeLocalGroup(data.groupId);
              socket.emit('group_call_error', {
                groupId: data.groupId,
                code: 'GROUP_ACCESS_DENIED',
                message: '您已无权访问该群组',
              });
              if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_ACCESS_DENIED' });
              return;
            }
            await handler(data, member, generation, typeof ack === 'function' ? ack : undefined);
          });
        } catch {
          socket.emit('group_call_error', {
            groupId: data.groupId,
            code: 'GROUP_SERVICE_UNAVAILABLE',
            message: '暂时无法验证群组权限，请稍后重试',
          });
          if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_SERVICE_UNAVAILABLE' });
        }
      };
      mediaHandlers.set(event, receive);
      socket.on(event, (data, ack) => receive(data, ack));
    }
    // 屏幕共享统一入口：解析 scope → 分发到对应的 media 事件处理器
    // 支持群组屏幕共享和私聊屏幕共享两种作用域
    socket.on(
      'screen_share',
      async (request: {
        scope: ScreenShareScope;
        action: string;
        payload?: Record<string, unknown>;
      }) => {
        if (!connected() || !request) return;
        let scopeId: MediaScopeId;
        try {
          scopeId = resolveScreenScope(request.scope, currentUser!.id);
          if (['start', 'end', 'leave', 'decline'].includes(request.action))
            screenStartGenerations.set(scopeId, (screenStartGenerations.get(scopeId) || 0) + 1);
          const generation = screenStartGenerations.get(scopeId);
          const isPrivate = typeof scopeId === 'string';
          if (
            isPrivate &&
            ['start', 'state'].includes(request.action) &&
            !(await UserModel.findByPk((request.scope as { peerId: number }).peerId))
          )
            throw new Error('共享对象不存在');
          if (
            !connected() ||
            (request.action === 'start' && screenStartGenerations.get(scopeId) !== generation)
          )
            return;
          if (request.action === 'state') {
            if (
              !isPrivate &&
              !(await GroupMember.findOne({ where: { groupId: scopeId, userId: currentUser!.id } }))
            )
              throw new Error('您已无权访问该群组');
            if (!connected()) return;
            socket.emit('group_call_state', {
              groupId: scopeId,
              sessions: await groupSessionService.getGroupState(scopeId),
            });
            return;
          }
          if (request.action === 'decline') {
            if (!isPrivate) return;
            await runGroupOperation(scopeId, async () => {
              const session = await groupSessionService.get(scopeId, 'screen');
              if (
                !session ||
                session.ownerUserId === currentUser!.id ||
                request.payload?.startedAt !== session.startedAt
              )
                return;
              await finishPrivateScreen(
                session,
                !connectedPrivateScreens.has(`${session.channelId}:${session.startedAt}`),
              );
            });
            return;
          }
          const event = screenShareActions[request.action as keyof typeof screenShareActions];
          if (!event) throw new Error('共享操作无效');
          // Scope and media type are derived here, never trusted from the payload.
          await mediaHandlers.get(event)?.(
            { ...request.payload, groupId: scopeId, deviceType: 2, type: 'screen' },
            undefined,
            isPrivate,
          );
        } catch (error) {
          socket.emit('screen_share_error', {
            scope: request.scope,
            message: error instanceof Error ? error.message : '屏幕共享失败',
          });
        }
      },
    );
    // 撤销本 socket 的群访问：退房、使待完成的启动失效、通知当前连接撤权，并清理其媒体会话
    async function revokeLocalGroup(groupId: number) {
      // Drop passive subscriptions before the first await.
      socket.leave(`group_${groupId}`);
      groupRooms.get(groupId)?.delete(socketId);
      if (!groupRooms.get(groupId)?.size) groupRooms.delete(groupId);
      for (const type of ['video', 'audio', 'screen']) {
        const key = `${groupId}:${type}`;
        groupCallStartGenerations.set(key, (groupCallStartGenerations.get(key) || 0) + 1);
      }
      const owned = [...ownedSessions.values()].filter((session) => session.groupId === groupId);
      for (const session of [...joinedMediaSessions.values()]) {
        if (session.groupId !== groupId) continue;
        socket.leave(session.channelId);
        joinedMediaSessions.delete(session.channelId);
        removeFromMediaRoom(socketId, session, currentUser?.id);
      }
      socket.emit('group_access_revoked', { groupId });
      for (const session of owned) {
        ownedSessions.delete(session.channelId);
        // Peers must close existing P2P connections even if Redis is unavailable.
        closeMediaSession(session);
      }
      await Promise.all(
        owned.map(async (session) => {
          if (session.type === 'screen') await screenAnnotationService.end(session);
          await groupSessionService.end(groupId, session.type, session.ownerUserId, session);
        }),
      );
    }
    // 订阅群访问撤销事件，按 userId 定位成员；未指定 userId 时处理该群的全部连接
    const unsubscribeGroupRevocation = onGroupAccessRevoked((event) => {
      if (!currentUser || (event.userId !== undefined && currentUser.id !== event.userId)) return;
      return revokeLocalGroup(event.groupId);
    });

    // 订阅登录会话撤销事件，匹配用户、会话及认证版本后断开连接
    const unsubscribeRevocation = onLoginSessionsRevoked((event) => {
      if (currentAuth?.userId !== event.userId || (event.sid && currentAuth.sid !== event.sid))
        return;
      // A delayed account-wide event must not revoke a new login created after
      // that password/version transaction committed.
      if (
        !event.sid &&
        event.revokedAuthVersion &&
        currentAuth.authVersion !== event.revokedAuthVersion
      )
        return;
      authenticationAttempt++;
      currentToken = null;
      socket.emit('auth_error', { message: '登录会话已撤销' });
      socket.disconnect(true);
    });
    // 入站事件中间件：authenticate 交给认证处理器，其余事件执行前重新验证登录会话
    socket.use(async ([event], next) => {
      if (event === 'authenticate') {
        next();
        return;
      }
      try {
        if (!currentToken || !currentAuth) throw new Error('Authentication required');
        const token = currentToken;
        const fresh = await validateAuthenticatedSession(token);
        if (
          !currentToken ||
          fresh.userId !== currentAuth.userId ||
          fresh.sid !== currentAuth.sid ||
          fresh.authVersion !== currentAuth.authVersion
        )
          throw new Error('Authentication changed');
        next();
      } catch {
        currentToken = null;
        socket.emit('auth_error', { message: '登录会话已失效' });
        next(new Error('AUTH_REVOKED'));
        socket.disconnect(true);
      }
    });

    // 客户端认证：验证 JWT → 加载用户信息 → 注册到 userMap → 广播在线状态
    socket.on(
      'authenticate',
      async (data: { token: string; nickname?: string; avatar?: string }) => {
        const attempt = ++authenticationAttempt;
        try {
          const payload = await validateAuthenticatedSession(data.token);
          if (attempt !== authenticationAttempt) return;
          if (
            currentAuth &&
            (payload.userId !== currentAuth.userId ||
              payload.sid !== currentAuth.sid ||
              payload.authVersion !== currentAuth.authVersion)
          ) {
            socket.disconnect(true);
            return;
          }
          // Publish the validated identity before the next await so revocation can
          // cancel an authentication that is still loading profile data.
          currentAuth = payload;
          const dbUser = await UserModel.findByPk(payload.userId);
          if (attempt !== authenticationAttempt) return;
          currentToken = data.token;
          clearTimeout(authenticationExpiryTimer);
          authenticationExpiryTimer = setTimeout(
            () => {
              authenticationAttempt++;
              currentToken = null;
              socket.emit('auth_error', { message: '登录凭据已过期，请重新认证' });
              socket.disconnect(true);
            },
            Math.max(0, Math.min(payload.exp * 1000 - Date.now(), 2_147_483_647)),
          );
          authenticationExpiryTimer.unref();
          const status = (dbUser?.status || 'online') as PresenceStatus;
          const previous = getPublicUser(payload.userId);

          currentUser = {
            id: payload.userId,
            socketId,
            username: payload.username,
            nickname: data.nickname || dbUser?.nickname || payload.username,
            avatar: data.avatar || dbUser?.avatar,
            status,
            bio: dbUser?.bio,
          };

          userMap.set(socketId, currentUser);
          socketToUserMap.set(socketId, payload.userId);

          socket.emit('authenticated', currentUser);
          socket.emit('user_list', getPublicUsers());
          emitPresenceChange(payload.userId, previous);
        } catch (error) {
          if (attempt !== authenticationAttempt) return;
          currentToken = null;
          socket.emit('auth_error', { message: 'Authentication failed' });
          socket.disconnect(true);
          console.error(
            'meeting authentication failed:',
            error instanceof Error ? error.name : 'UnknownError',
          );
        }
      },
    );

    // 更新在线状态（online/offline/busy），同步到 DB 并广播
    socket.on('status_update', async (data: { status: PresenceStatus }) => {
      if (!currentUser || !['online', 'offline', 'busy'].includes(data.status)) return;
      if (currentUser.status === data.status) return;

      const publicUser = getPublicUser(currentUser.id);
      const previous = publicUser ? { ...publicUser } : undefined;
      currentUser.status = data.status;
      userMap.set(socketId, currentUser);
      await UserModel.update({ status: data.status }, { where: { id: currentUser.id } });
      emitPresenceChange(currentUser.id, previous);
    });

    // 断线清理：移除用户、清理所有加入的群/媒体会话、结束拥有的会话、记录通话历史
    socket.on('disconnect', async () => {
      authenticationAttempt++;
      currentToken = null;
      for (const [key, value] of groupCallStartGenerations)
        groupCallStartGenerations.set(key, value + 1);
      clearTimeout(authenticationExpiryTimer);
      unsubscribeRevocation();
      unsubscribeGroupRevocation();
      sockets.delete(socketId);
      joinedBySocket.delete(socketId);
      const previous = currentUser ? getPublicUser(currentUser.id) : undefined;
      userMap.delete(socketId);
      socketToUserMap.delete(socketId);
      if (currentUser) emitPresenceChange(currentUser.id, previous);

      for (const peerSocketId of privateCallTracker.getPeerSocketIds(socketId)) {
        io.to(peerSocketId).emit('webrtc_hangup', { from: socketId });
      }
      await Promise.all(privateCallTracker.finishForSocket(socketId).map(recordPrivateCall));

      groupRooms.forEach((members, groupId) => {
        if (members.delete(socketId)) {
          socket
            .to(`group_${groupId}`)
            .emit('group_member_left', { socketId, userId: currentUser?.id });
        }
      });

      for (const session of [...joinedMediaSessions.values()]) {
        if (typeof session.groupId === 'string' && session.ownerSocketId !== socketId) {
          try {
            await runGroupOperation(session.groupId, () => finishPrivateScreen(session));
          } catch {
            closeMediaSession(session);
          }
        } else removeFromMediaRoom(socketId, session, currentUser?.id);
      }

      for (const session of ownedSessions.values()) {
        try {
          await runGroupOperation(session.groupId, async () => {
            const ended = currentUser
              ? await groupSessionService.end(
                  session.groupId,
                  session.type,
                  currentUser.id,
                  session,
                )
              : false;
            if (ended) {
              closeMediaSession(session);
              if (session.type === 'screen') {
                await screenAnnotationService.end(session);
                io.to(session.channelId).emit('screen_annotation_clear', {
                  groupId: session.groupId,
                  startedAt: session.startedAt,
                });
              }
              await recordGroupCall(session, currentUser);
              await emitGroupSessionEvent(session.groupId, 'group_call_ended', {
                from: socketId,
                groupId: session.groupId,
                type: session.type,
                startedAt: session.startedAt,
                deviceType: getSessionDeviceType(session.type),
              });
            }
          });
        } catch {
          closeMediaSession(session);
          console.error('group_disconnect_cleanup_failed', { groupId: session.groupId });
        }
      }
    });

    // 仅对当前用户隐藏消息，并向该用户所有已认证连接推送删除事件
    socket.on('messages_delete', async (data, ack) => {
      if (!currentUser) {
        ack?.({ ok: false, error: '请先登录' });
        return;
      }
      const userId = currentUser.id;
      try {
        const ids = await deleteMessages(userId, data?.kind, data?.ids);
        io.to(getUserSockets(userId)).emit('messages_deleted', { kind: data.kind, ids });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : '删除失败' });
      }
    });

    // 发送私聊消息：校验内容 → 保存（有 clientMessageId 时幂等）→ 非重复消息推送接收方连接并向发送方确认
    socket.on(
      'private_message',
      async (
        data: {
          to?: MeetingUser;
          message?: string;
          messageType?: string;
          media?: ChatMediaMessage['media'];
          clientMessageId?: string;
          quote?: MessageReference;
          forward?: MessageReference;
        },
        ack?: (result: unknown) => void,
      ) => {
        if (!currentUser || !data.to?.id) {
          ack?.({ ok: false, error: '消息无效' });
          return;
        }

        try {
          let messageContent = await getMessageContent(data, currentUser.id);
          if (data.quote)
            messageContent = await attachQuote(
              messageContent,
              currentUser.id,
              data.quote,
              'private',
              data.to.id,
            );
          const writeStartedAt = Date.now();
          const receiverSockets = getUserSockets(data.to.id);
          const { saved: savedMessage, duplicate } = await saveReliableMessage({
            kind: 'private',
            userId: currentUser.id,
            targetId: data.to.id,
            message: messageContent,
            clientMessageId: data.clientMessageId,
          });
          if (messageWriteMs.length < 10_000) messageWriteMs.push(Date.now() - writeStartedAt);

          const payload = {
            ...serializeChatMessage(savedMessage),
            from: socketId,
            fromUserId: currentUser.id,
            toUserId: data.to.id,
            time: savedMessage.createdAt?.toLocaleString() || new Date().toLocaleString(),
            createdAt: savedMessage.createdAt,
            sender: currentUser,
          };

          if (!duplicate)
            receiverSockets.forEach((targetSocketId) => {
              socket.to(targetSocketId).emit('private_message', payload);
            });
          ack?.({ ok: true, id: savedMessage.id, clientMessageId: data.clientMessageId });
        } catch (error) {
          messageWriteFailures++;
          console.error('save private message failed:', error);
          ack?.({ ok: false, error: '发送失败' });
        }
      },
    );

    // WebRTC 信令中继：将 offer/answer/ICE candidate 转发给目标 socket（私聊 P2P）
    socket.on('webrtc_offer', (data) => {
      if (data.to?.socketId) {
        socket.to(data.to.socketId).emit('webrtc_offer', {
          from: socketId,
          offer: data.offer,
          deviceType: data.deviceType,
        });
      }
    });

    socket.on('webrtc_answer', (data) => {
      if (data.to?.socketId) {
        socket.to(data.to.socketId).emit('webrtc_answer', {
          from: socketId,
          answer: data.answer,
        });
      }
    });

    socket.on('webrtc_ice', (data) => {
      if (data.to?.socketId) {
        socket.to(data.to.socketId).emit('webrtc_ice', {
          from: socketId,
          candidate: data.candidate,
        });
      }
    });

    // 发起私聊通话请求（视频/屏幕/语音），记录到通话追踪器并通知对方
    socket.on('webrtc_call_request', (data) => {
      const type = getPrivateCallType(data.deviceType);
      const calleeUserId = data.to?.socketId ? socketToUserMap.get(data.to.socketId) : undefined;
      if (!currentUser || !type || !data.to?.socketId || !calleeUserId) return;

      privateCallTracker.request({
        callId: typeof data.callId === 'string' ? data.callId : undefined,
        callerSocketId: socketId,
        calleeSocketId: data.to.socketId,
        callerUserId: currentUser.id,
        calleeUserId,
        type,
      });
      socket.to(data.to.socketId).emit('webrtc_call_request', {
        callId: data.callId,
        from: socketId,
        deviceType: data.deviceType,
        user: currentUser,
      });
    });

    // 转发振铃音标识（仅当 callId 匹配且通话尚未被接听）
    socket.on('webrtc_call_ringing', (data) => {
      if (!currentUser || typeof data?.callId !== 'string' || !data.to?.socketId) return;
      if (data.tone !== 'default' && data.tone !== 'classic') return;
      if (!privateCallTracker.isPending(data.to.socketId, socketId, data.callId)) return;
      socket.to(data.to.socketId).emit('webrtc_call_ringing', {
        from: socketId,
        callId: data.callId,
        tone: data.tone,
      });
    });

    // 转发通话响应：接听仅更新追踪状态；拒绝或建立失败时结束追踪并保存历史
    socket.on('webrtc_call_response', async (data) => {
      if (!data.to?.socketId) return;
      const setupFailed = data.accepted === false && data.reason === 'SETUP_FAILED';
      socket.to(data.to.socketId).emit('webrtc_call_response', {
        from: socketId,
        accepted: data.accepted,
        ...(setupFailed ? { reason: 'SETUP_FAILED' } : {}),
      });
      await recordPrivateCall(
        privateCallTracker.respond(data.to.socketId, socketId, data.accepted === true, setupFailed),
      );
    });

    // 接收客户端的接通上报，为已接听且未计时的通话记录开始时间；服务端不直接检测 WebRTC 连接
    socket.on('webrtc_call_connected', (data) => {
      if (!data.to?.socketId) return;
      privateCallTracker.connected(socketId, data.to.socketId);
    });

    // 挂断通话：通知对方 + 记录通话历史
    socket.on('webrtc_hangup', async (data) => {
      if (!data.to?.socketId) return;
      socket.to(data.to.socketId).emit('webrtc_hangup', {
        from: socketId,
      });
      await recordPrivateCall(privateCallTracker.finish(socketId, data.to.socketId));
    });

    // 订阅群聊房间：记录当前 socket，返回已订阅连接的成员列表和媒体状态；不新增数据库群成员
    onGroup('join_group', async (data: { groupId: number }) => {
      if (!currentUser || !data.groupId) return;
      const roomName = `group_${data.groupId}`;

      const sessions = await groupSessionService.getGroupState(data.groupId);
      if (!connected()) return;
      await socket.join(roomName);

      if (!groupRooms.has(data.groupId)) {
        groupRooms.set(data.groupId, new Set());
      }
      groupRooms.get(data.groupId)!.add(socketId);

      const members = Array.from(groupRooms.get(data.groupId)!)
        .map((sid) => userMap.get(sid))
        .filter(Boolean);

      socket.emit('group_members', { groupId: data.groupId, members });
      socket.emit('group_call_state', {
        groupId: data.groupId,
        sessions,
      });
      socket.to(roomName).emit('group_member_joined', {
        groupId: data.groupId,
        member: currentUser,
      });
    });

    // 取消当前 socket 的群聊房间订阅并广播离开；不删除数据库群成员关系
    onGroup('leave_group', (data: { groupId: number }) => {
      const roomName = `group_${data.groupId}`;
      const room = groupRooms.get(data.groupId);

      socket.leave(roomName);
      room?.delete(socketId);

      if (room?.size === 0) {
        groupRooms.delete(data.groupId);
      }

      socket.to(roomName).emit('group_member_left', { socketId, userId: currentUser?.id });
    });

    // 发送群聊消息：校验成员身份和发言权限 → 幂等保存到 DB → 推送到群房间
    onGroup(
      'group_message',
      async (
        data: {
          groupId: number;
          message?: string;
          messageType?: string;
          media?: ChatMediaMessage['media'];
          clientMessageId?: string;
          quote?: MessageReference;
          forward?: MessageReference;
        },
        _member,
        _generation,
        ack?: (result: unknown) => void,
      ) => {
        if (!currentUser || !Number.isInteger(data.groupId)) {
          ack?.({ ok: false, error: '消息无效' });
          return;
        }

        try {
          let messageContent = await getMessageContent(data, currentUser.id, data.groupId);
          if (data.quote)
            messageContent = await attachQuote(
              messageContent,
              currentUser.id,
              data.quote,
              'group',
              data.groupId,
            );
          const writeStartedAt = Date.now();
          const member = await GroupMember.findOne({
            where: { groupId: data.groupId, userId: currentUser.id },
          });
          if (!member || member.canSpeak === false) {
            ack?.({ ok: false, error: '无发送权限' });
            return;
          }
          const { saved: groupMessage, duplicate } = await saveReliableMessage({
            kind: 'group',
            userId: currentUser.id,
            targetId: data.groupId,
            message: messageContent,
            clientMessageId: data.clientMessageId,
          });
          if (messageWriteMs.length < 10_000) messageWriteMs.push(Date.now() - writeStartedAt);

          const payload = {
            ...serializeChatMessage(groupMessage),
            from: socketId,
            groupId: data.groupId,
            userId: currentUser.id,
            time: groupMessage.createdAt?.toLocaleString() || new Date().toLocaleString(),
            createdAt: groupMessage.createdAt,
            user: currentUser,
            sender: currentUser,
          };

          if (!duplicate) socket.to(`group_${data.groupId}`).emit('group_message', payload);
          ack?.({ ok: true, id: groupMessage.id, clientMessageId: data.clientMessageId });
        } catch (error) {
          messageWriteFailures++;
          console.error('save group message failed:', error);
          ack?.({ ok: false, error: '发送失败' });
        }
      },
    );

    // 群媒体/私聊屏幕共享信令中继：校验会话版本、目标资格及双方已加入同一会话后转发
    for (const [event, field] of [
      ['group_webrtc_offer', 'offer'],
      ['group_webrtc_answer', 'answer'],
      ['group_webrtc_ice', 'candidate'],
    ] as const) {
      onGroup(event, async (data) => {
        if (
          ![1, 2, 3].includes(data.deviceType) ||
          typeof data.to !== 'string' ||
          data.to === socketId
        )
          return;
        const type = getSessionType(data.deviceType);
        const session = await groupSessionService.get(data.groupId, type);
        if (
          !session ||
          session.groupId !== data.groupId ||
          session.type !== type ||
          data.startedAt !== session.startedAt
        )
          return;
        const target = userMap.get(data.to);
        if (!target || !sockets.has(data.to)) return;
        const targetMember =
          typeof data.groupId === 'string'
            ? privateScreenMembers(data.groupId).includes(target.id)
              ? { role: 'member' }
              : null
            : await GroupMember.findOne({ where: { groupId: data.groupId, userId: target.id } });
        if (
          !targetMember ||
          !connected() ||
          joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt ||
          joinedBySocket.get(data.to)?.get(session.channelId)?.startedAt !== session.startedAt
        )
          return;
        // Socket.IO's `to` also accepts room names: only an authenticated socket
        // in this exact session can be addressed, never an arbitrary room.
        socket.to(data.to).emit(event, {
          from: socketId,
          fromUser: currentUser,
          [field]: data[field],
          deviceType: data.deviceType,
          groupId: data.groupId,
          startedAt: session.startedAt,
        });
      });
    }

    // 发起群媒体或私聊屏幕共享：检查启动版本 → 创建或复用会话 → 新建时清理旧房间并广播
    onGroup(
      'group_call_start',
      async (
        data: { groupId: MediaScopeId; deviceType: number; quality?: unknown },
        _member,
        startGeneration,
      ) => {
        if (!currentUser || !data.groupId) return;
        const type = getSessionType(data.deviceType);
        const startKey = `${data.groupId}:${type}`;
        if (groupCallStartGenerations.get(startKey) !== startGeneration) return;
        if (
          typeof data.groupId === 'string' &&
          !privateScreenMembers(data.groupId).some(
            (id) => id !== currentUser!.id && getUserSockets(id).length,
          )
        ) {
          socket.emit('group_call_error', { groupId: data.groupId, message: '对方当前不在线' });
          return;
        }
        const result = await groupSessionService.start(data.groupId, type, currentUser);
        if (type === 'screen' && !result.created && result.session.ownerSocketId !== socketId) {
          socket.emit('group_call_error', {
            groupId: data.groupId,
            message: '已有屏幕共享正在进行，请重新进入',
          });
          return;
        }
        if (!connected() || groupCallStartGenerations.get(startKey) !== startGeneration) {
          if (result.created)
            await groupSessionService.end(data.groupId, type, currentUser.id, result.session);
          return;
        }
        if (result.created) {
          for (const peerId of mediaRooms.getSocketIds(result.session.channelId)) {
            const stale = joinedBySocket.get(peerId)?.get(result.session.channelId);
            if (stale && stale.startedAt !== result.session.startedAt) closeMediaSession(stale);
          }
          ownedSessions.set(result.session.channelId, result.session);
          if (type === 'screen' && isScreenQuality(data.quality)) {
            screenQualities.set(result.session.channelId, {
              groupId: data.groupId,
              startedAt: result.session.startedAt,
              quality: data.quality,
            });
          }
          await emitGroupSessionEvent(
            data.groupId,
            'group_call_started',
            {
              from: socketId,
              ...result.session,
              deviceType: data.deviceType,
              user: currentUser,
            },
            () => connected() && groupCallStartGenerations.get(startKey) === startGeneration,
          );
        }
        if (!connected()) return;
        socket.emit('group_call_state', {
          groupId: data.groupId,
          sessions: await groupSessionService.getGroupState(data.groupId),
        });
      },
    );

    // 结束群媒体或私聊屏幕共享：仅创建该会话的 socket 可通过此入口结束；屏幕会话同时清除标注
    onGroup(
      'group_call_end',
      async (data: { groupId: MediaScopeId; deviceType?: number; type?: GroupSessionType }) => {
        if (!currentUser || !data.groupId) return;
        const types: GroupSessionType[] = data.type
          ? [data.type]
          : data.deviceType
            ? [getSessionType(data.deviceType)]
            : ['video', 'audio', 'screen'];

        for (const type of types) {
          const startKey = `${data.groupId}:${type}`;
          groupCallStartGenerations.set(
            startKey,
            (groupCallStartGenerations.get(startKey) || 0) + 1,
          );
          const session = await groupSessionService.get(data.groupId, type);
          if (
            !session ||
            session.ownerSocketId !== socketId ||
            ownedSessions.get(session.channelId)?.startedAt !== session.startedAt
          )
            continue;
          const ended = await groupSessionService.end(data.groupId, type, currentUser.id, session);
          if (!ended || !session) continue;

          ownedSessions.delete(session.channelId);
          closeMediaSession(session);
          if (type === 'screen') {
            await screenAnnotationService.end(session);
            io.to(session.channelId).emit('screen_annotation_clear', {
              groupId: session.groupId,
              startedAt: session.startedAt,
            });
          }
          await recordGroupCall(session, currentUser);
          await emitGroupSessionEvent(data.groupId, 'group_call_ended', {
            from: socketId,
            groupId: data.groupId,
            type,
            startedAt: session.startedAt,
            deviceType: getSessionDeviceType(type),
          });
        }
      },
    );

    // 切换屏幕共享画质：仅发起 socket 可调 → 更新内存快照 → 广播给媒体房间全部连接
    onGroup(
      'screen_share_quality',
      async (data: { groupId: MediaScopeId; startedAt: string; quality: unknown }) => {
        if (!isScreenQuality(data.quality)) return;
        const session = await groupSessionService.get(data.groupId, 'screen');
        if (
          !connected() ||
          !session ||
          session.startedAt !== data.startedAt ||
          session.ownerSocketId !== socketId
        )
          return;
        const state = {
          groupId: data.groupId,
          startedAt: session.startedAt,
          quality: data.quality,
        };
        screenQualities.set(session.channelId, state);
        io.to(session.channelId).emit('screen_share_quality', state);
      },
    );

    // 加入群媒体或私聊屏幕共享：校验会话版本并入房；屏幕会话额外返回已有画质和标注快照
    // 私聊屏幕共享额外检查：同一用户不能从另一台设备重复加入
    onGroup(
      'join_group_call',
      async (data: { groupId: MediaScopeId; deviceType: number; startedAt: string }) => {
        if (!currentUser || !data.groupId) return;
        const type = getSessionType(data.deviceType);
        const session = await groupSessionService.get(data.groupId, type);
        if (
          !session ||
          session.groupId !== data.groupId ||
          session.type !== type ||
          session.startedAt !== data.startedAt
        ) {
          socket.emit('group_call_error', {
            groupId: data.groupId,
            type,
            code: 'GROUP_SESSION_CHANGED',
            message: '会话已更新，请重新进入；旧版客户端请升级',
          });
          return;
        }

        if (typeof data.groupId === 'string') {
          const otherDevice = mediaRooms
            .getSocketIds(session.channelId)
            .some((id) => id !== socketId && userMap.get(id)?.id === currentUser!.id);
          if (otherDevice) {
            socket.emit('group_call_error', {
              groupId: data.groupId,
              message: '您已在另一台设备加入共享',
            });
            return;
          }
          if (currentUser.id !== session.ownerUserId)
            connectedPrivateScreens.add(`${session.channelId}:${session.startedAt}`);
        }
        const snapshot =
          type === 'screen' ? await screenAnnotationService.getSnapshot(session) : [];
        if (!connected()) return;
        await socket.join(session.channelId);
        const { alreadyJoined } = mediaRooms.join(session.channelId, socketId, currentUser.id);
        joinedMediaSessions.set(session.channelId, session);

        const members = mediaRooms
          .getSocketIds(session.channelId)
          .map((sid) => userMap.get(sid))
          .filter(Boolean);

        socket.emit('group_call_members', {
          groupId: data.groupId,
          type,
          channelId: session.channelId,
          startedAt: session.startedAt,
          members,
        });
        if (type === 'screen') {
          const quality = screenQualities.get(session.channelId);
          if (quality?.startedAt === session.startedAt)
            socket.emit('screen_share_quality', quality);
          socket.emit('screen_annotation_snapshot', {
            groupId: session.groupId,
            startedAt: session.startedAt,
            actions: snapshot,
          });
        }
        if (!alreadyJoined) {
          socket.to(session.channelId).emit('group_call_member_joined', {
            groupId: data.groupId,
            type,
            channelId: session.channelId,
            startedAt: session.startedAt,
            member: currentUser,
          });
        }
        emitMediaPresence(session);
      },
    );

    // 离开群媒体通话：私聊屏幕共享直接结束整个会话，群聊仅移除当前成员
    onGroup('leave_group_call', async (data: { groupId: MediaScopeId; deviceType: number }) => {
      const type = getSessionType(data.deviceType);
      const session = joinedMediaSessions.get(`group:${data.groupId}:${type}`);
      if (!session) return;
      if (typeof data.groupId === 'string') {
        await finishPrivateScreen(session);
        return;
      }

      removeFromMediaRoom(socketId, session, currentUser?.id);
      socket.leave(session.channelId);
      joinedMediaSessions.delete(session.channelId);
    });

    // 屏幕标注草稿：仅当前屏幕共享者可提交；校验会话、入房状态及内容后广播给其他连接
    onGroup(
      'screen_annotation_draft',
      async (data: { groupId: MediaScopeId; startedAt: string; action: AnnotationDraft }) => {
        const session = await groupSessionService.get(data.groupId, 'screen');
        if (
          !currentUser ||
          !session ||
          session.startedAt !== data.startedAt ||
          joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
        )
          return;

        try {
          const action = screenAnnotationService.validateDraft(
            session,
            currentUser.id,
            data.action,
          );
          socket.to(session.channelId).emit('screen_annotation_draft', {
            groupId: session.groupId,
            startedAt: session.startedAt,
            action,
          });
        } catch (error) {
          socket.emit('screen_annotation_error', {
            message: error instanceof Error ? error.message : '标注失败',
          });
        }
      },
    );

    // 屏幕标注完成：仅当前屏幕共享者可提交；校验后保存到 Redis 并广播给媒体房间全部连接
    onGroup(
      'screen_annotation_complete',
      async (data: { groupId: MediaScopeId; startedAt: string; action: AnnotationDraft }) => {
        const session = await groupSessionService.get(data.groupId, 'screen');
        if (
          !currentUser ||
          !session ||
          session.startedAt !== data.startedAt ||
          joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
        )
          return;

        try {
          const action: AnnotationAction = {
            ...data.action,
            userId: currentUser.id,
            createdAt: new Date().toISOString(),
          };
          const saved = await screenAnnotationService.complete(session, currentUser.id, action);
          io.to(session.channelId).emit('screen_annotation_complete', {
            groupId: session.groupId,
            startedAt: session.startedAt,
            action: saved,
          });
        } catch (error) {
          socket.emit('screen_annotation_error', {
            message: error instanceof Error ? error.message : '标注失败',
          });
        }
      },
    );

    // 撤销屏幕标注（仅当前屏幕共享者）：移除当前会话最后一条标注并广播其 actionId
    onGroup(
      'screen_annotation_undo',
      async (data: { groupId: MediaScopeId; startedAt: string }) => {
        const session = await groupSessionService.get(data.groupId, 'screen');
        if (
          !currentUser ||
          !session ||
          session.startedAt !== data.startedAt ||
          joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
        )
          return;

        try {
          const actionId = await screenAnnotationService.undo(session, currentUser.id);
          io.to(session.channelId).emit('screen_annotation_undo', {
            groupId: session.groupId,
            startedAt: session.startedAt,
            actionId,
          });
        } catch (error) {
          socket.emit('screen_annotation_error', {
            message: error instanceof Error ? error.message : '撤销标注失败',
          });
        }
      },
    );

    // 清空当前会话的全部屏幕标注（仅当前屏幕共享者）：删除 Redis 快照并广播清空事件
    onGroup(
      'screen_annotation_clear',
      async (data: { groupId: MediaScopeId; startedAt: string }) => {
        const session = await groupSessionService.get(data.groupId, 'screen');
        if (
          !currentUser ||
          !session ||
          session.startedAt !== data.startedAt ||
          joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
        )
          return;

        try {
          await screenAnnotationService.clear(session, currentUser.id);
          io.to(session.channelId).emit('screen_annotation_clear', {
            groupId: session.groupId,
            startedAt: session.startedAt,
          });
        } catch (error) {
          socket.emit('screen_annotation_error', {
            message: error instanceof Error ? error.message : '清空标注失败',
          });
        }
      },
    );

    // 控制同一媒体会话中成员的麦克风权限（群聊仅群主，私聊屏幕共享仅发起者）：
    // 群聊 → 更新 DB 中 GroupMember.canSpeak
    // 私聊屏幕共享 → 更新内存中的 privateMicPermissions
    onGroup(
      'control_member_mic',
      async (
        data: { groupId: MediaScopeId; targetSocketId: string; canSpeak: boolean },
        member,
      ) => {
        if (member.role !== 'owner' || typeof data.canSpeak !== 'boolean') return;
        const target = userMap.get(data.targetSocketId);
        if (
          !target ||
          ![...joinedMediaSessions.values()].some(
            (session) =>
              session.groupId === data.groupId &&
              joinedBySocket.get(data.targetSocketId)?.get(session.channelId)?.startedAt ===
                session.startedAt,
          )
        )
          return;
        if (typeof data.groupId === 'string') {
          const session = await groupSessionService.get(data.groupId, 'screen');
          if (
            !session ||
            session.ownerUserId !== currentUser?.id ||
            !privateScreenMembers(data.groupId).includes(target.id) ||
            target.id === currentUser.id
          )
            return;
          const permissions =
            privateMicPermissions.get(session.channelId) || new Map<number, boolean>();
          permissions.set(target.id, data.canSpeak);
          privateMicPermissions.set(session.channelId, permissions);
          io.to(getUserSockets(target.id)).emit('mic_permission_changed', {
            groupId: data.groupId,
            canSpeak: data.canSpeak,
          });
          return;
        }
        const targetMember = await GroupMember.findOne({
          where: { groupId: data.groupId, userId: target.id },
        });
        if (!targetMember || targetMember.role === 'owner') return;
        await targetMember.update({ canSpeak: data.canSpeak });
        io.to(getUserSockets(target.id)).emit('mic_permission_changed', {
          groupId: data.groupId,
          canSpeak: data.canSpeak,
        });
      },
    );

    // 同步客户端麦克风状态：拒绝被禁言成员的取消静音上报，再广播给同作用域媒体房间的其他连接；不直接操作音轨
    onGroup('toggle_mic', (data: { groupId: MediaScopeId; muted: boolean }, member) => {
      if (typeof data.muted !== 'boolean' || (!data.muted && member.canSpeak === false)) return;
      for (const session of joinedMediaSessions.values()) {
        if (session.groupId === data.groupId)
          socket.to(session.channelId).emit('member_mic_changed', {
            groupId: data.groupId,
            socketId,
            muted: data.muted,
          });
      }
    });
  });
  return io;
};

export default initialMeeting;
