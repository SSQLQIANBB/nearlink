<template>
  <button
    v-if="unread.total > 0 && currentPath !== '/remote'"
    type="button"
    class="global-unread-shortcut"
    aria-label="打开未读消息"
    @click="router.push('/remote')"
  >
    消息
    <span class="global-unread-shortcut__badge">
      {{ unread.total > 99 ? '99+' : unread.total }}
    </span>
  </button>
</template>
<script setup lang="ts">
import { isAppInBackground } from '@/services/appVisibility';
import { computed, h, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useNotification } from 'naive-ui';
import { useSocketStore } from '@/stores/socket';
import { useAuthStore } from '@/stores/auth';
import { useUnreadStore } from '@/stores/unread';
import { getMyGroups } from '@/api/group';
import {
  getOfflineMessages,
  markMessagesAsRead,
  getGroupCursors,
  getGroupMessagesAfter,
} from '@/api/message';
import {
  advanceGroupCursor,
  initializeGroupCursor,
  readGroupCursors,
} from '@/services/groupMessageCursor';
import notificationService from '@/services/notificationService';

const socketStore = useSocketStore();
const authStore = useAuthStore();
const unread = useUnreadStore();
const router = useRouter();
const currentPath = computed(() => router.currentRoute.value.path);
const notification = useNotification();
let loadGeneration = 0;
const catchingUp = new Set<number>();
const liveDuringCatchUp = new Map<number, number>();

function notificationTitle(value: string) {
  return () => h('span', { class: 'global-message-title', style: { color: '#f8fafc' } }, value);
}

async function subscribeGroups() {
  const generation = ++loadGeneration;
  try {
    const [groups, offline] = await Promise.allSettled([getMyGroups(), getOfflineMessages()]);
    if (generation !== loadGeneration) return;
    if (groups.status === 'fulfilled') {
      const userId = authStore.currentUser?.id;
      const groupIds = groups.value.groups.map((group) => group.id);
      let initialCursors = userId ? readGroupCursors(userId) : {};
      if (userId && groupIds.some((id) => initialCursors[id] === undefined)) {
        try {
          const latest = await getGroupCursors();
          if (generation !== loadGeneration) return;
          for (const id of groupIds) {
            if (initialCursors[id] === undefined) {
              initialCursors[id] = latest.cursors[id] || 0;
              initializeGroupCursor(userId, id, initialCursors[id]);
            }
          }
        } catch (error) {
          console.error('获取初始群消息游标失败:', error);
        }
      }
      groupIds.forEach((id) => catchingUp.add(id));
      socketStore.setSubscribedGroups(groupIds);
      if (userId)
        void catchUpGroups(
          userId,
          groupIds.filter((id) => initialCursors[id] !== undefined),
          { ...initialCursors },
          generation,
        );
      else catchingUp.clear();
    } else console.error('订阅群组失败:', groups.reason);
    if (offline.status === 'rejected') {
      console.error('加载未读消息失败:', offline.reason);
      return;
    }
    let newCount = 0;
    offline.value.messages.forEach((item) => {
      unread.rememberSender(item.sender);
      if (unread.receivePrivate(item.id, item.fromUserId, false)) newCount++;
    });
    if (newCount && currentPath.value !== '/remote' && notificationService.shouldNotify('private'))
      notification.create({
        title: notificationTitle('未读消息'),
        content: () =>
          h(
            'span',
            { class: 'global-message-text', style: { color: '#dbeafe' } },
            `内容：您有 ${newCount} 条未读私信`,
          ),
        closable: false,
        duration: 5000,
      });
  } catch (error) {
    console.error('加载全局消息订阅失败:', error);
  }
}

async function catchUpGroups(
  userId: number,
  groupIds: number[],
  cursors: Record<number, number>,
  generation: number,
) {
  for (const groupId of groupIds) {
    let afterId = Number(cursors[groupId]) || 0;
    let completed = false;
    try {
      for (let page = 0; page < 100; page++) {
        const result = await getGroupMessagesAfter(groupId, afterId);
        if (generation !== loadGeneration) return;
        for (const item of result.messages) {
          if (item.id <= afterId) continue;
          afterId = item.id;
          advanceGroupCursor(userId, groupId, item.id);
          if (item.userId === userId) continue;
          const active = currentPath.value === `/group-chat/${groupId}` && !isAppInBackground();
          unread.receiveGroup(item.id, groupId, active);
        }
        if (!result.hasMore || !result.messages.length) {
          completed = true;
          break;
        }
      }
    } catch (error) {
      console.error('补齐群消息失败:', groupId, error);
    }
    if (generation === loadGeneration && completed) {
      const liveId = liveDuringCatchUp.get(groupId);
      if (liveId) advanceGroupCursor(userId, groupId, liveId);
    }
    if (completed) {
      liveDuringCatchUp.delete(groupId);
      catchingUp.delete(groupId);
    }
  }
}

function handlePrivate(data: any) {
  const senderId = Number(data.fromUserId);
  if (!senderId) return;
  const active =
    router.currentRoute.value.path === '/remote' &&
    unread.activePrivateUserId === senderId &&
    !isAppInBackground();
  unread.rememberSender(data.sender);
  if (active && data.id) void markMessagesAsRead([Number(data.id)]);
  if (!unread.receivePrivate(Number(data.id), senderId, active) || active) return;
  const sender = data.sender || socketStore.userList.find((user) => user.id === senderId);
  if (!notificationService.shouldNotify('private')) return;
  if (isAppInBackground())
    void notificationService.showMessage(
      sender?.nickname || sender?.username || '联系人',
      data.message,
      sender?.avatar,
      () => {
        void router.push({ path: '/remote', query: { tab: 'users', contact: String(senderId) } });
      },
    );
  else notificationService.playAlert('private');
  notification.create({
    title: notificationTitle(`${sender?.nickname || sender?.username || '联系人'}：消息`),
    content: () =>
      h(
        'button',
        {
          type: 'button',
          class: 'global-message-link',
          style: { color: '#dbeafe' },
          onClick: () => {
            void router.push({
              path: '/remote',
              query: { tab: 'users', contact: String(senderId) },
            });
          },
        },
        `内容：${notificationService.previewMessage(data.message ?? '', 'private')}`,
      ),
    closable: false,
    duration: 5000,
  });
}

function handleGroup(data: any) {
  const groupId = Number(data.groupId);
  if (!groupId) return;
  if (authStore.currentUser?.id) {
    if (catchingUp.has(groupId))
      liveDuringCatchUp.set(
        groupId,
        Math.max(liveDuringCatchUp.get(groupId) || 0, Number(data.id) || 0),
      );
    else advanceGroupCursor(authStore.currentUser.id, groupId, Number(data.id));
  }
  const active =
    router.currentRoute.value.path === `/group-chat/${groupId}` && !isAppInBackground();
  if (!unread.receiveGroup(Number(data.id), groupId, active) || active) return;
  if (!notificationService.shouldNotify('group')) return;
  if (isAppInBackground())
    void notificationService.showGroupMessage(
      '群组消息',
      data.user?.nickname || data.user?.username || '群成员',
      data.message,
      data.user?.avatar,
      () => {
        void router.push(`/group-chat/${groupId}`);
      },
    );
  else notificationService.playAlert('group');
  notification.create({
    title: notificationTitle(`${data.user?.nickname || data.user?.username || '群成员'}：消息`),
    content: () =>
      h(
        'button',
        {
          type: 'button',
          class: 'global-message-link',
          style: { color: '#dbeafe' },
          onClick: () => {
            void router.push(`/group-chat/${groupId}`);
          },
        },
        `内容：${notificationService.previewMessage(data.message ?? '', 'group')}`,
      ),
    closable: false,
    duration: 5000,
  });
}

watch(
  () => socketStore.socket,
  (current, previous) => {
    previous?.off('private_message', handlePrivate);
    previous?.off('group_message', handleGroup);
    current?.on('private_message', handlePrivate);
    current?.on('group_message', handleGroup);
  },
  { immediate: true },
);
watch(
  () => socketStore.authenticated,
  (ready) => {
    if (ready) void subscribeGroups();
    else {
      loadGeneration++;
      catchingUp.clear();
      liveDuringCatchUp.clear();
      socketStore.setSubscribedGroups([]);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  socketStore.socket?.off('private_message', handlePrivate);
  socketStore.socket?.off('group_message', handleGroup);
});
</script>

<style>
.global-message-title,
.global-message-text {
  display: block;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.global-message-link {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 16px;
}
.global-message-link:hover {
  text-decoration: underline;
}
.n-notification-container .n-notification {
  width: min(260px, calc(100vw - 24px));
  padding: 0 10px;
  border: 1px solid #334155;
  border-radius: 13px;
  background: #172033;
  color: #dbeafe;
  box-shadow: 0 14px 36px #02061755;
  --n-color: #172033;
  --n-title-text-color: #f8fafc;
  --n-text-color: #dbeafe;
}
.n-notification-container .n-notification .n-notification-main {
  width: 100%;
  min-width: 0;
  margin-left: 0;
  padding-block: 8px;
}
.n-notification-container .n-notification .n-notification-main__header {
  color: #f8fafc;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.n-notification-container .n-notification .n-notification-main__content {
  min-width: 0;
  margin-top: 2px;
  color: #dbeafe;
  overflow: hidden;
  font-size: 12px;
  line-height: 16px;
}
.global-unread-shortcut {
  position: fixed;
  left: 16px;
  bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 2500;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid #bfdbfe;
  border-radius: 24px;
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 600;
  box-shadow: 0 6px 20px #0002;
  cursor: pointer;
}
.global-unread-shortcut__badge {
  min-width: 22px;
  padding: 2px 5px;
  border-radius: 11px;
  background: #ef4444;
  color: white;
  font-size: 12px;
}
</style>
