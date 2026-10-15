<template><span v-if="false" /></template>

<script setup lang="ts">
import { openScreenShare, createScreenShareApi, type ScreenShareId } from '@/features/screenShare';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { isAppInBackground } from '@/services/appVisibility';
import { onBeforeUnmount, watch } from 'vue';
import { useDialog, type DialogReactive } from 'naive-ui';
import { useRouter } from 'vue-router';
import { useSocketStore } from '@/stores/socket';
import { useAuthStore } from '@/stores/auth';
import type { GroupSession } from '@/services/groupSessionState';
import notificationService from '@/services/notificationService';
import { isDesktopWindow } from '@/services/desktopAuxiliaryContext';
import { openDesktopGroupWindow } from '@/services/desktopAuxiliaryWindows';

const dialog = useDialog();
const router = useRouter();
const socketStore = useSocketStore();
const authStore = useAuthStore();
const pending = new Map<string, DialogReactive>();
const ringtoneKeys = new Map<string, string>();
const seen = new Set<string>();

function stopRingtone(key: string, eventId?: string) {
  const activeId = ringtoneKeys.get(key);
  if (!activeId || (eventId && activeId !== eventId)) return;
  notificationService.stopCallRingtone(`group:${activeId}`);
  ringtoneKeys.delete(key);
}

function finishInvitation(key: string, eventId: string) {
  if (ringtoneKeys.get(key) !== eventId) return;
  pending.delete(key);
  stopRingtone(key, eventId);
}

function dismissAll() {
  pending.forEach((item) => item.destroy());
  pending.clear();
  ringtoneKeys.forEach((eventId, key) => stopRingtone(key, eventId));
  seen.clear();
}

function handleStarted(
  data: Omit<GroupSession, 'groupId'> & {
    groupId: ScreenShareId;
    deviceType?: number;
    user?: { nickname?: string; username?: string };
  },
) {
  if (!authStore.currentUser || data.ownerUserId === authStore.currentUser.id) return;
  const type =
    data.type || (data.deviceType === 2 ? 'screen' : data.deviceType === 3 ? 'audio' : 'video');
  const privateScreen = typeof data.groupId === 'string';
  const scope = privateScreen
    ? { kind: 'private' as const, peerId: data.ownerUserId }
    : { kind: 'group' as const, id: data.groupId as number };
  const path = privateScreen
    ? `/screen-share/private/${data.ownerUserId}`
    : `/group-${type}/${data.groupId}`;
  const decline = () => {
    if (privateScreen)
      createScreenShareApi(scope, () => socketStore.socket).send('decline', {
        startedAt: data.startedAt,
      });
  };
  if (privateScreen && mediaOccupancy.current.value) {
    decline();
    return;
  }
  if (router.currentRoute.value.path === path) return;
  const key = `${data.groupId}:${type}`;
  const eventId = `${key}:${data.startedAt}`;
  if (seen.has(eventId)) return;
  seen.add(eventId);
  pending.get(key)?.destroy();
  stopRingtone(key);
  const label = type === 'screen' ? '屏幕共享' : type === 'audio' ? '语音通话' : '视频通话';
  ringtoneKeys.set(key, eventId);
  pending.set(
    key,
    dialog.info({
      positiveButtonProps: { type: 'primary' },
      title: `${privateScreen ? '' : '群组'}${label}邀请`,
      content: privateScreen
        ? `${data.user?.nickname || data.user?.username || '对方'} 邀请你观看屏幕共享`
        : `${data.user?.nickname || data.user?.username || '群成员'} 邀请你加入群组 ${data.groupId} 的${label}`,
      positiveText: '接受邀请',
      negativeText: '暂不加入',
      onPositiveClick: () => {
        if (type === 'screen') {
          return openScreenShare(scope, router, false)
            .then(() => finishInvitation(key, eventId))
            .catch((error) => {
              dialog.warning({
                title: '无法加入共享',
                content: error.message,
                positiveText: '知道了',
              });
              return false;
            });
        }
        if (isDesktopWindow) {
          return openDesktopGroupWindow(path)
            .then(() => {
              finishInvitation(key, eventId);
            })
            .catch((error) => {
              dialog.warning({
                positiveButtonProps: { type: 'primary' },
                title: '无法加入通话',
                content: error.message,
                positiveText: '知道了',
              });
              return false;
            });
        }
        if (mediaOccupancy.current.value) {
          dialog.warning({
            positiveButtonProps: { type: 'primary' },
            title: '当前媒体会话进行中',
            content: '请先结束当前通话或远程控制，再加入群组通话。',
            positiveText: '知道了',
          });
          return false;
        }
        finishInvitation(key, eventId);
        void router.push(path);
      },
      onNegativeClick: () => {
        decline();
        finishInvitation(key, eventId);
      },
      onClose: () => {
        decline();
        finishInvitation(key, eventId);
      },
      maskClosable: false,
    }),
  );
  notificationService.startCallRingtone(`group:${eventId}`);
  if (isAppInBackground())
    void notificationService.showCall(
      data.user?.nickname || data.user?.username || '群成员',
      type,
      undefined,
      () => window.focus(),
    );
}

function handleEnded(data: {
  groupId: ScreenShareId;
  type?: string;
  deviceType?: number;
  startedAt?: string;
}) {
  const key = `${data.groupId}:${data.type || (data.deviceType === 2 ? 'screen' : data.deviceType === 3 ? 'audio' : 'video')}`;
  if (data.startedAt && ringtoneKeys.get(key) !== `${key}:${data.startedAt}`) return;
  pending.get(key)?.destroy();
  pending.delete(key);
  stopRingtone(key);
}

watch(
  () => socketStore.socket,
  (socket, previous) => {
    previous?.off('group_call_started', handleStarted);
    previous?.off('group_call_ended', handleEnded);
    previous?.off('disconnect', dismissAll);
    dismissAll();
    socket?.on('group_call_started', handleStarted);
    socket?.on('group_call_ended', handleEnded);
    socket?.on('disconnect', dismissAll);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  socketStore.socket?.off('group_call_started', handleStarted);
  socketStore.socket?.off('group_call_ended', handleEnded);
  socketStore.socket?.off('disconnect', dismissAll);
  dismissAll();
});
</script>
