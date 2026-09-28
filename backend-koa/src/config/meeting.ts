import { type Server } from 'http';
import { onGroupAccessRevoked, runGroupOperation } from '../services/groupAccessCoordinator';
import { Server as Socket } from 'socket.io';
import { onLoginSessionsRevoked, validateAuthenticatedSession, type AuthenticatedSessionPayload } from '../services/loginSessionService';
import { File, GroupMember, GroupMessage, Message, User as UserModel } from '../models';
import { saveReliableMessage } from '../services/reliableMessageService';
import {
  GroupSessionService,
  type GroupSession,
  type GroupSessionType,
} from '../services/groupSessionService';
import { MediaRoomRegistry } from '../services/mediaRoomRegistry';
import { RedisGroupSessionStore } from '../services/redisGroupSessionStore';
import { RedisScreenAnnotationStore } from '../services/redisScreenAnnotationStore';
import {
  ScreenAnnotationService,
  type AnnotationAction,
  type AnnotationDraft,
} from '../services/screenAnnotationService';
import {
  createCallHistoryMessage,
  PrivateCallTracker,
  serializeChatMessage,
  type CallHistoryType,
  type PrivateCallHistoryRecord,
} from '../services/callHistoryService';
import {
  createChatMediaMessage,
  type ChatMediaMessage,
} from '../services/chatMediaMessageService';

type PresenceStatus = 'online' | 'offline' | 'busy';

type MeetingUser = {
  id: number;
  socketId: string;
  username: string;
  nickname?: string;
  avatar?: string;
  status: PresenceStatus;
  bio?: string;
};


function getSessionType(deviceType: number): GroupSessionType {
  if (deviceType === 3) return 'audio';
  return deviceType === 2 ? 'screen' : 'video';
}

function getSessionDeviceType(type: GroupSessionType) {
  if (type === 'screen') return 2;
  return type === 'audio' ? 3 : 1;
}

function getPrivateCallType(deviceType: number): CallHistoryType | null {
  if (deviceType === 0) return 'video';
  if (deviceType === 1) return 'screen';
  if (deviceType === 2) return 'audio';
  return null;
}

async function getMessageContent(
  data: { message?: string; messageType?: string; media?: ChatMediaMessage['media'] },
  userId: number,
  groupId?: number,
) {
  if (data.messageType === 'image' || data.messageType === 'voice') {
    const fileId = data.media?.fileId;
    if (!Number.isSafeInteger(fileId)) throw new Error('媒体文件无效');

    const file = await File.findOne({ where: { id: fileId, userId } });
    const belongsToTarget = groupId === undefined
      ? file?.groupId == null
      : Number(file?.groupId) === groupId;
    if (!file || !belongsToTarget) throw new Error('媒体文件无效');

    return createChatMediaMessage({
      type: data.messageType,
      media: { ...data.media, url: file.fileUrl },
    });
  }
  const message = data.message?.trim();
  if (!message || message.length > 10000) throw new Error('消息无效');
  return message;
}

const initialMeeting = (server: Server) => {
  const io = new Socket(server, {
    path: '/meeting',
    cors: {
      origin: '*',
    },
  });

  const userMap = new Map<string, MeetingUser>();
  const socketToUserMap = new Map<string, number>();
  const groupRooms = new Map<number, Set<string>>();
  const mediaRooms = new MediaRoomRegistry();
  const groupSessionService = new GroupSessionService(new RedisGroupSessionStore());
  const screenAnnotationService = new ScreenAnnotationService(new RedisScreenAnnotationStore());
  function getPublicUsers() {
    const users = new Map<number, MeetingUser>();

    for (const user of userMap.values()) {
      if (user.status !== 'offline') {
        users.set(user.id, user);
      }
    }

    return [...users.values()];
  }

  function getPublicUser(userId: number): MeetingUser | undefined {
    return getPublicUsers().find(user => user.id === userId);
  }

  function samePublicUser(left?: MeetingUser, right?: MeetingUser) {
    if (!left || !right) return left === right;
    return left.socketId === right.socketId
      && left.status === right.status
      && left.username === right.username
      && left.nickname === right.nickname
      && left.avatar === right.avatar
      && left.bio === right.bio;
  }

  function getUserSockets(userId: number) {
    return [...socketToUserMap.entries()]
      .filter(([, mappedUserId]) => mappedUserId === userId)
      .map(([socketId]) => socketId);
  }

  const joinedBySocket = new Map<string, Map<string, GroupSession>>();
  const sockets = new Map<string, import('socket.io').Socket>();

  const messageWriteMs: number[] = [];
  const privateCallTracker = new PrivateCallTracker();
  let messageWriteFailures = 0;
  const metricsTimer = setInterval(() => {
    const transports = { websocket: 0, polling: 0 };
    for (const client of io.sockets.sockets.values()) {
      if (client.conn.transport.name === 'websocket') transports.websocket++;
      else transports.polling++;
    }
    const latencies = messageWriteMs.splice(0).sort((a, b) => a - b);
    const p95 = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
    console.info('realtime_metrics', JSON.stringify({
      connections: io.engine.clientsCount, transports,
      messageWrites: latencies.length, messageWriteP95Ms: p95,
      messageWriteFailures,
    }));
    messageWriteFailures = 0;
  }, 60_000);
  metricsTimer.unref();
  server.once?.('close', () => clearInterval(metricsTimer));

  async function emitGroupSessionEvent(groupId: number, event: string, payload: unknown, isCurrent?: () => boolean) {
    const members = await GroupMember.findAll({ where: { groupId } });
    if (isCurrent && !isCurrent()) return;
    const socketIds = members.flatMap(member => getUserSockets(member.userId));
    if (socketIds.length) io.to(socketIds).emit(event, payload);
  }

  async function savePrivateCallHistory(record: PrivateCallHistoryRecord) {
    const saved = await Message.create({
      fromUserId: record.callerUserId,
      toUserId: record.calleeUserId,
      message: createCallHistoryMessage(record),
      isRead: true,
    });
    const payload = serializeChatMessage(saved);
    const socketIds = [...new Set([
      ...getUserSockets(record.callerUserId),
      ...getUserSockets(record.calleeUserId),
    ])];
    if (socketIds.length) io.to(socketIds).emit('private_call_history', payload);
  }

  async function saveGroupCallHistory(session: GroupSession, user?: MeetingUser | null) {
    const durationSeconds = Math.max(
      1,
      Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000),
    );
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

  async function recordPrivateCall(record: PrivateCallHistoryRecord | null) {
    if (!record) return;
    try {
      await savePrivateCallHistory(record);
    } catch (error) {
      console.error('save private call history failed:', error);
    }
  }

  async function recordGroupCall(session: GroupSession, user?: MeetingUser | null) {
    try {
      await saveGroupCallHistory(session, user);
    } catch (error) {
      console.error('save group call history failed:', error);
    }
  }

  function emitPresenceChange(userId: number, previous?: MeetingUser) {
    const next = getPublicUser(userId);
    if (samePublicUser(previous, next)) return;
    io.emit('user_presence', next ? { userId, user: next } : { userId });
  }

  function emitMediaPresence(session: GroupSession) {
    io.to(session.channelId).emit('group_call_presence', {
      groupId: session.groupId,
      type: session.type,
      channelId: session.channelId,
      startedAt: session.startedAt,
      userIds: mediaRooms.getUserIds(session.channelId),
    });
  }

  function emitEmptyMediaPresence(session: GroupSession) {
    io.to(`group_${session.groupId}`).emit('group_call_presence', {
      groupId: session.groupId,
      type: session.type,
      channelId: session.channelId,
      startedAt: session.startedAt,
      userIds: [],
    });
  }

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

  function closeMediaSession(session: GroupSession) {
    const peers = mediaRooms.getSocketIds(session.channelId).filter(peerId =>
      joinedBySocket.get(peerId)?.get(session.channelId)?.startedAt === session.startedAt);
    if (peers.length) io.to(peers).emit('group_call_ended', {
      groupId: session.groupId, type: session.type, deviceType: getSessionDeviceType(session.type),
      startedAt: session.startedAt,
    });
    for (const peerId of peers) {
      joinedBySocket.get(peerId)?.delete(session.channelId);
      mediaRooms.leave(session.channelId, peerId);
      sockets.get(peerId)?.leave(session.channelId);
    }
    if (!mediaRooms.getSocketIds(session.channelId).length) emitEmptyMediaPresence(session);
  }

  io.on('connection', (socket) => {
    const socketId = socket.id;
    let currentUser: MeetingUser | null = null;
    let currentAuth: AuthenticatedSessionPayload | null = null;
    let currentToken: string | null = null;
    let authenticationAttempt = 0;
    let authenticationExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    const joinedMediaSessions = new Map<string, GroupSession>();
    const ownedSessions = new Map<string, GroupSession>();
    const groupCallStartGenerations = new Map<string, number>();

    joinedBySocket.set(socketId, joinedMediaSessions);
    sockets.set(socketId, socket);
    const connected = () => !!currentUser && !!currentToken && socket.connected !== false;
    function onGroup(event: string, handler: (data: any, member: GroupMember, generation?: number, ack?: (result: unknown) => void) => unknown) {
      socket.on(event, async (data: any, ack?: (result: unknown) => void) => {
        if (!data || !Number.isSafeInteger(data.groupId) || data.groupId <= 0 || !connected()) {
          if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_ACCESS_DENIED' });
          return;
        }
        const types: GroupSessionType[] = ['video', 'audio', 'screen'];
        const requiresDeviceType = ['group_call_start', 'join_group_call', 'leave_group_call', 'group_webrtc_offer', 'group_webrtc_answer', 'group_webrtc_ice'].includes(event);
        if ((requiresDeviceType || data.deviceType !== undefined) && ![1, 2, 3].includes(data.deviceType)) return;
        if (data.type !== undefined && !types.includes(data.type)) return;
        let generation: number | undefined;
        // Cancellation must invalidate a start even while its Redis write is pending.
        if (event === 'group_call_start' || event === 'group_call_end') {
          const affected = event === 'group_call_start' ? [getSessionType(data.deviceType)]
            : data.type ? [data.type] : data.deviceType ? [getSessionType(data.deviceType)] : types;
          for (const type of affected) {
            const key = `${data.groupId}:${type}`;
            generation = (groupCallStartGenerations.get(key) || 0) + 1;
            groupCallStartGenerations.set(key, generation);
          }
        }
        try {
          await runGroupOperation(data.groupId, async () => {
            if (!connected()) return;
            const member = await GroupMember.findOne({ where: { groupId: data.groupId, userId: currentUser!.id } });
            if (!connected()) return;
            if (!member) {
              await revokeLocalGroup(data.groupId);
              socket.emit('group_call_error', { groupId: data.groupId, code: 'GROUP_ACCESS_DENIED', message: '您已无权访问该群组' });
              if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_ACCESS_DENIED' });
              return;
            }
            await handler(data, member, generation, typeof ack === 'function' ? ack : undefined);
          });
        } catch {
          socket.emit('group_call_error', { groupId: data.groupId, code: 'GROUP_SERVICE_UNAVAILABLE', message: '暂时无法验证群组权限，请稍后重试' });
          if (typeof ack === 'function') ack({ ok: false, code: 'GROUP_SERVICE_UNAVAILABLE' });
        }
      });
    }
    async function revokeLocalGroup(groupId: number) {
      // Drop passive subscriptions before the first await.
      socket.leave(`group_${groupId}`);
      groupRooms.get(groupId)?.delete(socketId);
      if (!groupRooms.get(groupId)?.size) groupRooms.delete(groupId);
      for (const type of ['video', 'audio', 'screen']) {
        const key = `${groupId}:${type}`;
        groupCallStartGenerations.set(key, (groupCallStartGenerations.get(key) || 0) + 1);
      }
      const owned = [...ownedSessions.values()].filter(session => session.groupId === groupId);
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
      await Promise.all(owned.map(async session => {
        if (session.type === 'screen') await screenAnnotationService.end(session);
        await groupSessionService.end(groupId, session.type, session.ownerUserId, session);
      }));
    }
    const unsubscribeGroupRevocation = onGroupAccessRevoked(event => {
      if (!currentUser || (event.userId !== undefined && currentUser.id !== event.userId)) return;
      return revokeLocalGroup(event.groupId);
    });

    const unsubscribeRevocation = onLoginSessionsRevoked(event => {
      if (currentAuth?.userId !== event.userId || (event.sid && currentAuth.sid !== event.sid)) return;
      // A delayed account-wide event must not revoke a new login created after
      // that password/version transaction committed.
      if (!event.sid && event.revokedAuthVersion && currentAuth.authVersion !== event.revokedAuthVersion) return;
      authenticationAttempt++;
      currentToken = null;
      socket.emit('auth_error', { message: '登录会话已撤销' });
      socket.disconnect(true);
    });
    socket.use(async ([event], next) => {
      if (event === 'authenticate') { next(); return; }
      try {
        if (!currentToken || !currentAuth) throw new Error('Authentication required');
        const token = currentToken;
        const fresh = await validateAuthenticatedSession(token);
        if (!currentToken || fresh.userId !== currentAuth.userId || fresh.sid !== currentAuth.sid
          || fresh.authVersion !== currentAuth.authVersion) throw new Error('Authentication changed');
        next();
      } catch {
        currentToken = null;
        socket.emit('auth_error', { message: '登录会话已失效' });
        next(new Error('AUTH_REVOKED'));
        socket.disconnect(true);
      }
    });

    socket.on('authenticate', async (data: { token: string; nickname?: string; avatar?: string }) => {
      const attempt = ++authenticationAttempt;
      try {
        const payload = await validateAuthenticatedSession(data.token);
        if (attempt !== authenticationAttempt) return;
        if (currentAuth && (payload.userId !== currentAuth.userId || payload.sid !== currentAuth.sid || payload.authVersion !== currentAuth.authVersion)) {
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
        authenticationExpiryTimer = setTimeout(() => {
          authenticationAttempt++;
          currentToken = null;
          socket.emit('auth_error', { message: '登录凭据已过期，请重新认证' });
          socket.disconnect(true);
        }, Math.max(0, Math.min(payload.exp * 1000 - Date.now(), 2_147_483_647)));
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
        console.error('meeting authentication failed:', error instanceof Error ? error.name : 'UnknownError');
      }
    });

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

    socket.on('disconnect', async () => {
      authenticationAttempt++;
      currentToken = null;
      for (const [key, value] of groupCallStartGenerations) groupCallStartGenerations.set(key, value + 1);
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
          socket.to(`group_${groupId}`).emit('group_member_left', { socketId, userId: currentUser?.id });
        }
      });

      for (const session of joinedMediaSessions.values()) {
        removeFromMediaRoom(socketId, session, currentUser?.id);
      }

      for (const session of ownedSessions.values()) {
        try { await runGroupOperation(session.groupId, async () => {
        const ended = currentUser
          ? await groupSessionService.end(session.groupId, session.type, currentUser.id, session)
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
        }); } catch {
          closeMediaSession(session);
          console.error('group_disconnect_cleanup_failed', { groupId: session.groupId });
        }
      }

    });

    socket.on('private_message', async (data: { to?: MeetingUser; message?: string; messageType?: string; media?: ChatMediaMessage['media']; clientMessageId?: string }, ack?: (result: unknown) => void) => {
      if (!currentUser || !data.to?.id) {
        ack?.({ ok: false, error: '消息无效' }); return;
      }

      try {
        const messageContent = await getMessageContent(data, currentUser.id);
        const writeStartedAt = Date.now();
        const receiverSockets = getUserSockets(data.to.id);
        const { saved: savedMessage, duplicate } = await saveReliableMessage({
          kind: 'private', userId: currentUser.id, targetId: data.to.id,
          message: messageContent, clientMessageId: data.clientMessageId,
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

        if (!duplicate) receiverSockets.forEach((targetSocketId) => {
          socket.to(targetSocketId).emit('private_message', payload);
        });
        ack?.({ ok: true, id: savedMessage.id, clientMessageId: data.clientMessageId });
      } catch (error) {
        messageWriteFailures++;
        console.error('save private message failed:', error);
        ack?.({ ok: false, error: '发送失败' });
      }
    });

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

    socket.on('webrtc_call_ringing', (data) => {
      if (!currentUser || typeof data?.callId !== 'string' || !data.to?.socketId) return;
      if (data.tone !== 'default' && data.tone !== 'classic') return;
      if (!privateCallTracker.isPending(data.to.socketId, socketId, data.callId)) return;
      socket.to(data.to.socketId).emit('webrtc_call_ringing', {
        from: socketId, callId: data.callId, tone: data.tone,
      });
    });

    socket.on('webrtc_call_response', async (data) => {
      if (!data.to?.socketId) return;
      socket.to(data.to.socketId).emit('webrtc_call_response', {
        from: socketId,
        accepted: data.accepted,
      });
      await recordPrivateCall(
        privateCallTracker.respond(data.to.socketId, socketId, data.accepted === true),
      );
    });

    socket.on('webrtc_call_connected', (data) => {
      if (!data.to?.socketId) return;
      privateCallTracker.connected(socketId, data.to.socketId);
    });

    socket.on('webrtc_hangup', async (data) => {
      if (!data.to?.socketId) return;
      socket.to(data.to.socketId).emit('webrtc_hangup', {
        from: socketId,
      });
      await recordPrivateCall(privateCallTracker.finish(socketId, data.to.socketId));
    });

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

    onGroup('group_message', async (data: { groupId: number; message?: string; messageType?: string; media?: ChatMediaMessage['media']; clientMessageId?: string }, _member, _generation, ack?: (result: unknown) => void) => {
      if (!currentUser || !Number.isInteger(data.groupId)) {
        ack?.({ ok: false, error: '消息无效' }); return;
      }

      try {
        const messageContent = await getMessageContent(data, currentUser.id, data.groupId);
        const writeStartedAt = Date.now();
        const member = await GroupMember.findOne({ where: { groupId: data.groupId, userId: currentUser.id } });
        if (!member || member.canSpeak === false) { ack?.({ ok: false, error: '无发送权限' }); return; }
        const { saved: groupMessage, duplicate } = await saveReliableMessage({
          kind: 'group', userId: currentUser.id, targetId: data.groupId,
          message: messageContent, clientMessageId: data.clientMessageId,
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
    });

    for (const [event, field] of [['group_webrtc_offer', 'offer'], ['group_webrtc_answer', 'answer'], ['group_webrtc_ice', 'candidate']] as const) {
      onGroup(event, async data => {
        if (![1, 2, 3].includes(data.deviceType) || typeof data.to !== 'string' || data.to === socketId) return;
        const type = getSessionType(data.deviceType);
        const session = await groupSessionService.get(data.groupId, type);
        if (!session || session.groupId !== data.groupId || session.type !== type || data.startedAt !== session.startedAt) return;
        const target = userMap.get(data.to);
        if (!target || !sockets.has(data.to)) return;
        const targetMember = await GroupMember.findOne({ where: { groupId: data.groupId, userId: target.id } });
        if (!targetMember || !connected()
          || joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
          || joinedBySocket.get(data.to)?.get(session.channelId)?.startedAt !== session.startedAt) return;
        // Socket.IO's `to` also accepts room names: only an authenticated socket
        // in this exact session can be addressed, never an arbitrary room.
        socket.to(data.to).emit(event, {
          from: socketId, fromUser: currentUser, [field]: data[field],
          deviceType: data.deviceType, groupId: data.groupId, startedAt: session.startedAt,
        });
      });
    }

    onGroup('group_call_start', async (data: { groupId: number; deviceType: number }, _member, startGeneration) => {
      if (!currentUser || !data.groupId) return;
      const type = getSessionType(data.deviceType);
      const startKey = `${data.groupId}:${type}`;
      if (groupCallStartGenerations.get(startKey) !== startGeneration) return;
      const result = await groupSessionService.start(data.groupId, type, currentUser);
      if (!connected() || groupCallStartGenerations.get(startKey) !== startGeneration) {
        if (result.created) await groupSessionService.end(data.groupId, type, currentUser.id, result.session);
        return;
      }
      if (result.created) {
        for (const peerId of mediaRooms.getSocketIds(result.session.channelId)) {
          const stale = joinedBySocket.get(peerId)?.get(result.session.channelId);
          if (stale && stale.startedAt !== result.session.startedAt) closeMediaSession(stale);
        }
        ownedSessions.set(result.session.channelId, result.session);
        await emitGroupSessionEvent(data.groupId, 'group_call_started', {
          from: socketId,
          ...result.session,
          deviceType: data.deviceType,
          user: currentUser,
        }, () => connected() && groupCallStartGenerations.get(startKey) === startGeneration);
      }
      if (!connected()) return;
      socket.emit('group_call_state', {
        groupId: data.groupId,
        sessions: await groupSessionService.getGroupState(data.groupId),
      });
    });

    onGroup('group_call_end', async (data: { groupId: number; deviceType?: number; type?: GroupSessionType }) => {
      if (!currentUser || !data.groupId) return;
      const types: GroupSessionType[] = data.type
        ? [data.type]
        : data.deviceType
          ? [getSessionType(data.deviceType)]
          : ['video', 'audio', 'screen'];

      for (const type of types) {
        const startKey = `${data.groupId}:${type}`;
        groupCallStartGenerations.set(startKey, (groupCallStartGenerations.get(startKey) || 0) + 1);
        const session = await groupSessionService.get(data.groupId, type);
        if (!session || session.ownerSocketId !== socketId || ownedSessions.get(session.channelId)?.startedAt !== session.startedAt) continue;
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
    });

    onGroup('join_group_call', async (data: { groupId: number; deviceType: number; startedAt: string }) => {
      if (!currentUser || !data.groupId) return;
      const type = getSessionType(data.deviceType);
      const session = await groupSessionService.get(data.groupId, type);
      if (!session || session.groupId !== data.groupId || session.type !== type || session.startedAt !== data.startedAt) {
        socket.emit('group_call_error', { groupId: data.groupId, type, code: 'GROUP_SESSION_CHANGED', message: '会话已更新，请重新进入；旧版客户端请升级' });
        return;
      }

      const snapshot = type === 'screen' ? await screenAnnotationService.getSnapshot(session) : [];
      if (!connected()) return;
      await socket.join(session.channelId);
      const { alreadyJoined } = mediaRooms.join(
        session.channelId,
        socketId,
        currentUser.id,
      );
      joinedMediaSessions.set(session.channelId, session);

      const members = mediaRooms.getSocketIds(session.channelId)
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
    });

    onGroup('leave_group_call', async (data: { groupId: number; deviceType: number }) => {
      const type = getSessionType(data.deviceType);
      const session = joinedMediaSessions.get(`group:${data.groupId}:${type}`);
      if (!session) return;

      removeFromMediaRoom(socketId, session, currentUser?.id);
      socket.leave(session.channelId);
      joinedMediaSessions.delete(session.channelId);
    });

    onGroup('screen_annotation_draft', async (data: {
      groupId: number;
      startedAt: string;
      action: AnnotationDraft;
    }) => {
      const session = await groupSessionService.get(data.groupId, 'screen');
      if (
        !currentUser
        || !session
        || session.startedAt !== data.startedAt
        || joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
      ) return;

      try {
        const action = screenAnnotationService.validateDraft(session, currentUser.id, data.action);
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
    });

    onGroup('screen_annotation_complete', async (data: {
      groupId: number;
      startedAt: string;
      action: AnnotationDraft;
    }) => {
      const session = await groupSessionService.get(data.groupId, 'screen');
      if (
        !currentUser
        || !session
        || session.startedAt !== data.startedAt
        || joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt
      ) return;

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
    });

    onGroup('screen_annotation_undo', async (data: {
      groupId: number;
      startedAt: string;
    }) => {
      const session = await groupSessionService.get(data.groupId, 'screen');
      if (!currentUser || !session || session.startedAt !== data.startedAt
        || joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt) return;

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
    });

    onGroup('screen_annotation_clear', async (data: {
      groupId: number;
      startedAt: string;
    }) => {
      const session = await groupSessionService.get(data.groupId, 'screen');
      if (!currentUser || !session || session.startedAt !== data.startedAt
        || joinedMediaSessions.get(session.channelId)?.startedAt !== session.startedAt) return;

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
    });

    onGroup('control_member_mic', async (data: { groupId: number; targetSocketId: string; canSpeak: boolean }, member) => {
      if (member.role !== 'owner' || typeof data.canSpeak !== 'boolean') return;
      const target = userMap.get(data.targetSocketId);
      if (!target || ![...joinedMediaSessions.values()].some(session => session.groupId === data.groupId
        && joinedBySocket.get(data.targetSocketId)?.get(session.channelId)?.startedAt === session.startedAt)) return;
      const targetMember = await GroupMember.findOne({ where: { groupId: data.groupId, userId: target.id } });
      if (!targetMember || targetMember.role === 'owner') return;
      await targetMember.update({ canSpeak: data.canSpeak });
      io.to(getUserSockets(target.id)).emit('mic_permission_changed', { groupId: data.groupId, canSpeak: data.canSpeak });
    });

    onGroup('toggle_mic', (data: { groupId: number; muted: boolean }, member) => {
      if (typeof data.muted !== 'boolean' || (!data.muted && member.canSpeak === false)) return;
      for (const session of joinedMediaSessions.values()) {
        if (session.groupId === data.groupId) socket.to(session.channelId).emit('member_mic_changed', {
          groupId: data.groupId, socketId, muted: data.muted,
        });
      }
    });
  });
  return io;
};

export default initialMeeting;
