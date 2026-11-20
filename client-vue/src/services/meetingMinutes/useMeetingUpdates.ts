import { watch } from 'vue';
import type { MeetingUpdate } from '@/api/meeting';
import { useSocketStore } from '@/stores/socket';

export function useMeetingUpdates(onUpdate: (change: MeetingUpdate) => void, onReconnect: () => void) {
  const store = useSocketStore();
  watch(() => store.socket, (socket, _, onCleanup) => {
    if (!socket) return;
    socket.on('meeting_updated', onUpdate);
    onCleanup(() => { socket.off('meeting_updated', onUpdate); });
  }, { immediate: true, flush: 'sync' });

  // 重新认证完成后再补查，首次进入页面由原有 HTTP 请求加载。
  watch(() => store.authenticated, (authenticated) => {
    if (authenticated) onReconnect();
  });
}
