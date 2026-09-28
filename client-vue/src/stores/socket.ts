import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { io, type Socket } from 'socket.io-client';
import type { User } from '@/api/auth';
import {
  groupSessionState,
  type GroupSession,
  type GroupSessionType,
} from '@/services/groupSessionState';
import { refreshAccessToken } from '@/utils/request';
import { publicEnv } from '@/config/env';
import { useAuthStore } from './auth';
import { pinia } from '@/stores';

export type PresenceStatus = 'online' | 'offline' | 'busy';
export type OnlineUser = User & { socketId: string };
type PresenceChange = { userId: number; user?: OnlineUser };

type GroupSessionEvent = Omit<GroupSession, 'type'> & {
  type?: GroupSessionType;
  deviceType?: number;
};

export const useSocketStore = defineStore('socket', () => {
  const socket = shallowRef<Socket | null>(null);
  const connected = ref(false);
  const authenticated = ref(false);
  const userList = ref<OnlineUser[]>([]);
  const joinedGroupIds = new Set<number>();
  const subscribedGroupIds = new Set<number>();

  let credentials: { token: string; user: User } | null = null;

  function authenticate() {
    if (!socket.value?.connected || !credentials) return;

    socket.value.emit('authenticate', {
      token: credentials.token,
      nickname: credentials.user.nickname,
      avatar: credentials.user.avatar,
    });
  }

  function handleConnect() {
    connected.value = true;
    authenticated.value = false;
    authenticate();
  }

  function handleDisconnect() {
    connected.value = false;
    authenticated.value = false;
    userList.value = [];
  }

  function handleAuthenticated() {
    authenticated.value = true;
    joinedGroupIds.forEach(groupId => {
      socket.value?.emit('join_group', { groupId });
    });
  }

  async function handleAuthError() {
    const authStore = useAuthStore(pinia);
    const generation = authStore.authGeneration;
    const res = await refreshAccessToken();
    if (generation !== authStore.authGeneration || authStore.loggingOut) return;

    if (!res) {
      await authStore.logout({ callApi: false, navigate: true });
    }
    authenticated.value = false;
    userList.value = [];
  }

  function handleUserList(users: OnlineUser[]) {
    userList.value = users.filter(user => (
      user.id !== credentials?.user.id && user.socketId !== socket.value?.id
    ));
  }

  function handleUserPresence(change: PresenceChange) {
    if (!authenticated.value || !Number.isInteger(change.userId)) return;
    const users = userList.value.filter(user => user.id !== change.userId);
    if (change.user && change.user.id === change.userId && change.user.id !== credentials?.user.id) {
      users.push(change.user);
    }
    userList.value = users;
  }

  function resolveSessionType(data: { type?: GroupSessionType; deviceType?: number }) {
    if (data.deviceType === 3) return data.type || 'audio';
    return data.type || (data.deviceType === 2 ? 'screen' : 'video');
  }

  function handleGroupCallState(data: {
    groupId: number;
    sessions: { video: GroupSession | null; audio: GroupSession | null; screen: GroupSession | null };
  }) {
    groupSessionState.applySnapshot(data.groupId, data.sessions);
  }

  function handleGroupCallStarted(data: GroupSessionEvent) {
    groupSessionState.applyStarted({
      ...data,
      type: resolveSessionType(data),
    });
  }

  function handleGroupCallEnded(data: {
    groupId: number;
    type?: GroupSessionType;
    deviceType?: number;
    startedAt?: string;
  }) {
    const current = groupSessionState.getSession(data.groupId, resolveSessionType(data));
    if (data.startedAt && current && data.startedAt !== current.startedAt) return;
    groupSessionState.applyEnded(data.groupId, resolveSessionType(data));
  }

  function handleGroupAccessRevoked(data: { groupId: number }) {
    groupSessionState.clearGroup(data.groupId);
    joinedGroupIds.delete(data.groupId);
    subscribedGroupIds.delete(data.groupId);
  }

  function bindEvents(target: Socket) {
    target.on('connect', handleConnect);
    target.on('disconnect', handleDisconnect);
    target.on('authenticated', handleAuthenticated);
    target.on('auth_error', handleAuthError);
    target.on('user_list', handleUserList);
    target.on('user_presence', handleUserPresence);
    target.on('group_call_state', handleGroupCallState);
    target.on('group_call_started', handleGroupCallStarted);
    target.on('group_call_ended', handleGroupCallEnded);
    target.on('group_access_revoked', handleGroupAccessRevoked);
  }

  function unbindEvents(target: Socket) {
    target.off('connect', handleConnect);
    target.off('disconnect', handleDisconnect);
    target.off('authenticated', handleAuthenticated);
    target.off('auth_error', handleAuthError);
    target.off('user_list', handleUserList);
    target.off('user_presence', handleUserPresence);
    target.off('group_call_state', handleGroupCallState);
    target.off('group_call_started', handleGroupCallStarted);
    target.off('group_call_ended', handleGroupCallEnded);
    target.off('group_access_revoked', handleGroupAccessRevoked);
  }

  function connect(token: string, user: User) {
    credentials = { token, user };

    if (!socket.value) {
      const target = io(publicEnv.socketUrl || window.location.origin, {
        path: '/meeting',
        autoConnect: false,
        transports: ['websocket', 'polling'],
        tryAllTransports: true,
      });

      socket.value = target;

      bindEvents(target);
      target.connect();
    } else if (!socket.value.connected) {
      socket.value.connect();
    } else {
      authenticate();
    }

    return socket.value;
  }

  function disconnect() {
    if (socket.value) {
      unbindEvents(socket.value);
      socket.value.disconnect();
    }

    socket.value = null;
    credentials = null;
    connected.value = false;
    authenticated.value = false;
    userList.value = [];
    joinedGroupIds.clear();
    subscribedGroupIds.clear();
  }

  function joinGroup(groupId: number) {
    joinedGroupIds.add(groupId);
    if (authenticated.value) socket.value?.emit('join_group', { groupId });
  }

  function leaveGroup(groupId: number) {
    if (subscribedGroupIds.has(groupId)) return;
    joinedGroupIds.delete(groupId);
    if (authenticated.value) socket.value?.emit('leave_group', { groupId });
  }

  function setSubscribedGroups(groupIds: number[]) {
    const next = new Set(groupIds);
    for (const id of subscribedGroupIds) {
      if (!next.has(id)) {
        subscribedGroupIds.delete(id);
        joinedGroupIds.delete(id);
        if (authenticated.value) socket.value?.emit('leave_group', { groupId: id });
      }
    }
    for (const id of next) {
      if (!subscribedGroupIds.has(id)) {
        subscribedGroupIds.add(id);
        joinGroup(id);
      }
    }
  }

  function updateStatus(status: PresenceStatus) {
    if (authenticated.value) socket.value?.emit('status_update', { status });
  }

  return {
    socket,
    connected,
    authenticated,
    userList,
    connect,
    disconnect,
    joinGroup,
    leaveGroup,
    setSubscribedGroups,
    updateStatus,
  };
});
