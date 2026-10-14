import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { User } from '@/api/auth';

export const useUnreadStore = defineStore('unread', () => {
  const privateCounts = ref<Record<number, number>>({});
  const groupCounts = ref<Record<number, number>>({});
  const activePrivateUserId = ref<number | null>(null);
  const privateContacts = ref<Record<number, User>>({});
  const seenPrivate = new Set<number>();
  const seenGroup = new Set<number>();
  const privateTotal = computed(() =>
    Object.values(privateCounts.value).reduce((a, b) => a + b, 0),
  );
  const groupTotal = computed(() => Object.values(groupCounts.value).reduce((a, b) => a + b, 0));
  const total = computed(() => privateTotal.value + groupTotal.value);

  function receivePrivate(id: number, senderId: number, active: boolean) {
    if (id && seenPrivate.has(id)) return false;
    if (id) seenPrivate.add(id);
    if (!active)
      privateCounts.value = {
        ...privateCounts.value,
        [senderId]: (privateCounts.value[senderId] || 0) + 1,
      };
    return true;
  }
  function receiveGroup(id: number, groupId: number, active: boolean) {
    if (id && seenGroup.has(id)) return false;
    if (id) seenGroup.add(id);
    if (!active)
      groupCounts.value = {
        ...groupCounts.value,
        [groupId]: (groupCounts.value[groupId] || 0) + 1,
      };
    return true;
  }
  function readPrivate(userId: number) {
    privateCounts.value = { ...privateCounts.value, [userId]: 0 };
  }
  function readGroup(groupId: number) {
    groupCounts.value = { ...groupCounts.value, [groupId]: 0 };
  }
  function rememberSender(user?: User) {
    if (user?.id) privateContacts.value = { ...privateContacts.value, [user.id]: user };
  }
  function reset() {
    privateCounts.value = {};
    groupCounts.value = {};
    privateContacts.value = {};
    activePrivateUserId.value = null;
    seenPrivate.clear();
    seenGroup.clear();
  }
  return {
    privateCounts,
    groupCounts,
    privateContacts,
    activePrivateUserId,
    privateTotal,
    groupTotal,
    total,
    receivePrivate,
    receiveGroup,
    rememberSender,
    readPrivate,
    readGroup,
    reset,
  };
});
