<template>
  <n-config-provider :theme-overrides="designTheme" style="height: 100%; overflow: auto;">
    <n-message-provider>
      <n-notification-provider>
      <n-dialog-provider>
        <GroupCallInvitations />
        <GlobalPrivateCall />
        <GlobalRemoteControl />
        <GlobalRemoteControlHost />
        <GlobalMessages />
        <DesktopTitlebar v-if="showDesktopTitlebar" />
        <div class="app-route-content"><RouterView /></div>
      </n-dialog-provider>
      </n-notification-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import DesktopTitlebar from '@/components/DesktopTitlebar.vue';
const showDesktopTitlebar = import.meta.env.VITE_DESKTOP === 'true';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { useSocketStore } from '@/stores/socket';
import GroupCallInvitations from '@/components/GroupCallInvitations.vue';
import GlobalPrivateCall from '@/components/GlobalPrivateCall.vue';
import GlobalRemoteControl from '@/components/GlobalRemoteControl.vue';
import GlobalRemoteControlHost from '@/components/GlobalRemoteControlHost.vue';
import GlobalMessages from '@/components/GlobalMessages.vue';
import { useUnreadStore } from '@/stores/unread';
import { useNotificationSettingsStore } from '@/stores/notificationSettings';
import { useRemoteControlStore } from '@/stores/remoteControl';

import { useRoute } from 'vue-router';
import type { GlobalThemeOverrides } from 'naive-ui';
const route = useRoute();
const designTheme = computed<GlobalThemeOverrides>(() => ['/remote', '/groups', '/profile'].includes(route.path) || route.path.startsWith('/group-chat/') ? {
  common: { primaryColor: '#2563eb', primaryColorHover: '#1d4ed8', primaryColorPressed: '#1e40af', errorColor: '#dc2626', errorColorHover: '#b91c1c', errorColorPressed: '#991b1b', borderRadius: '12px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  Avatar: { borderRadius: '50%' },
} : {});

const authStore = useAuthStore();
const { token, currentUser } = storeToRefs(authStore);
const socketStore = useSocketStore();
const notificationSettings = useNotificationSettingsStore();
const remoteControl = useRemoteControlStore();
const refreshRemoteCapabilities = () => { if (token.value && currentUser.value && !authStore.loggingOut) void remoteControl.refreshCapabilities(); };
onMounted(() => window.addEventListener('focus', refreshRemoteCapabilities));
onUnmounted(() => window.removeEventListener('focus', refreshRemoteCapabilities));
watch(() => [currentUser.value?.id, authStore.authGeneration], () => {
  remoteControl.reset();
  refreshRemoteCapabilities();
}, { immediate: true });

watch(() => currentUser.value?.id, userId => {
  if (userId) void notificationSettings.load(userId);
  else notificationSettings.reset();
}, { immediate: true });

watch(
  [token, currentUser],
  ([currentToken, user]) => {
    if (currentToken && user) {
      socketStore.connect(currentToken, user);
    } else {
      socketStore.disconnect();
      useUnreadStore().reset();
    }
  },
  { immediate: true },
);
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* 保持入口 HTML 无内联 style，避免原生 CSP nonce 阻断组件动态样式。 */
input,
textarea,
select {
  font-size: 16px;
}

#app {
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

html,
body {
  width: 100%;
  min-width: 0;
  overflow-x: hidden;
}

button,
input,
textarea,
select {
  max-width: 100%;
}

@media (max-width: 767px) {
  html, body { height: 100%; overflow: hidden; overscroll-behavior: none; touch-action: pan-x pan-y; }
  body { position: fixed; inset: 0; }
  #app .n-config-provider, #app .n-scrollbar-container, .n-modal-container { overscroll-behavior: none; }
  #app .h-screen { height: 100dvh; }
  #app .mobile-sidebar-toggle,
  #app .mobile-sidebar-close {
    min-height: 40px;
    padding-inline: 14px;
    border-radius: 999px;
    box-shadow: 0 3px 12px #0f172a14;
  }
  #app .mobile-sidebar-toggle { margin-right: 12px; }
  #app .mobile-sidebar-close { margin: 12px; }
  .n-modal-container .n-card,
  .n-modal-container .n-dialog {
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    overflow: auto;
  }
}
</style>
