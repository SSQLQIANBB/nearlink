import { readonly, ref } from 'vue';

export type MediaType = 'video' | 'audio' | 'screen';

export type ParticipantSnapshot = {
  groupId: number;
  type: MediaType;
  channelId: string;
  userIds: number[];
};

export function createMediaParticipantState() {
  const channels = new Map<string, string>();
  const participants = new Map<string, Set<number>>();
  const mutableVersion = ref(0);
  const key = (groupId: number, type: MediaType) => `${groupId}:${type}`;

  function setChannel(groupId: number, type: MediaType, channelId: string) {
    const stateKey = key(groupId, type);
    if (channels.get(stateKey) === channelId) return;
    channels.set(stateKey, channelId);
    if (participants.delete(stateKey)) mutableVersion.value += 1;
  }

  function apply(snapshot: ParticipantSnapshot) {
    const stateKey = key(snapshot.groupId, snapshot.type);
    const channelId = channels.get(stateKey);
    if (channelId && channelId !== snapshot.channelId) return false;

    channels.set(stateKey, snapshot.channelId);
    participants.set(stateKey, new Set(snapshot.userIds));
    mutableVersion.value += 1;
    return true;
  }

  function userIds(groupId: number, type: MediaType) {
    return [...(participants.get(key(groupId, type)) ?? [])].sort((left, right) => left - right);
  }

  function isParticipating(groupId: number, type: MediaType, userId: number) {
    return participants.get(key(groupId, type))?.has(userId) ?? false;
  }

  function clear(groupId: number, type: MediaType) {
    const stateKey = key(groupId, type);
    channels.delete(stateKey);
    if (participants.delete(stateKey)) mutableVersion.value += 1;
  }

  return {
    version: readonly(mutableVersion),
    setChannel,
    apply,
    userIds,
    isParticipating,
    clear,
  };
}
