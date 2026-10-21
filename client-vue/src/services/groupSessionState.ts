import { reactive } from 'vue';

export type GroupSessionType = 'video' | 'audio' | 'screen';

export type GroupSession = {
  groupId: number;
  type: GroupSessionType;
  channelId: string;
  ownerUserId: number;
  ownerSocketId: string;
  startedAt: string;
};

export type GroupSessionSnapshot = {
  video: GroupSession | null;
  audio: GroupSession | null;
  screen: GroupSession | null;
};

function getKey(groupId: number, type: GroupSessionType) {
  return `${groupId}:${type}`;
}

export function createGroupSessionState() {
  const sessions = reactive(new Map<string, GroupSession>());

  function applySnapshot(groupId: number, snapshot: GroupSessionSnapshot) {
    for (const type of ['video', 'audio', 'screen'] as const) {
      const session = snapshot[type];
      if (session) {
        sessions.set(getKey(groupId, type), session);
      } else {
        sessions.delete(getKey(groupId, type));
      }
    }
  }

  function applyStarted(session: GroupSession) {
    sessions.set(getKey(session.groupId, session.type), session);
  }

  function applyEnded(groupId: number, type: GroupSessionType) {
    sessions.delete(getKey(groupId, type));
  }

  function getSession(groupId: number, type: GroupSessionType) {
    return sessions.get(getKey(groupId, type)) || null;
  }

  function getButtonLabel(groupId: number, type: GroupSessionType) {
    if (getSession(groupId, type)) {
      if (type === 'video') return '进入视频';
      return type === 'audio' ? '进入语音' : '进入共享';
    }
    if (type === 'video') return '视频通话';
    return type === 'audio' ? '语音通话' : '屏幕共享';
  }

  function clearGroup(groupId: number) {
    sessions.delete(getKey(groupId, 'video'));
    sessions.delete(getKey(groupId, 'audio'));
    sessions.delete(getKey(groupId, 'screen'));
  }

  return {
    sessions,
    applySnapshot,
    applyStarted,
    applyEnded,
    getSession,
    getButtonLabel,
    clearGroup,
  };
}

export const groupSessionState = createGroupSessionState();
