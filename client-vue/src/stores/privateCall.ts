import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

export type CallUser = {
  id: number;
  socketId: string;
  username?: string;
  nickname?: string;
  avatar?: string;
};

export const usePrivateCallStore = defineStore('privateCall', () => {
  const request = shallowRef<{ user: CallUser; type: 0 | 1 | 2 } | null>(null);
  const busy = ref(false);
  return { request, busy };
});
