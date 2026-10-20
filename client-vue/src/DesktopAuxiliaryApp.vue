<template>
  <n-config-provider :theme-overrides="appTheme">
    <n-message-provider>
      <n-notification-provider>
        <n-dialog-provider>
          <template v-if="content?.kind === 'image'">
            <ChatImagePreview
              :key="content.src"
              :src="content.src"
              :alt="content.alt"
              @close="closeAuxiliaryWindow"
            />
          </template>
          <template v-else-if="content?.kind === 'private'">
            <GlobalPrivateCall />
          </template>
          <RouterView v-else />
          <div
            v-if="desktopShareStarting"
            class="desktop-share-launch"
            role="status"
          >
            正在启动屏幕共享…
          </div>
          <div
            v-if="desktopShareError"
            class="desktop-share-error"
            role="alert"
          >
            {{ desktopShareError }}
            <button @click="desktopShareError = ''">关闭提示</button>
          </div>
        </n-dialog-provider>
      </n-notification-provider>
    </n-message-provider>
  </n-config-provider>
</template>
<script setup lang="ts">
import { appTheme } from '@/theme';
import { onBeforeUnmount, watch } from 'vue';
import {
  NConfigProvider,
  NMessageProvider,
  NNotificationProvider,
  NDialogProvider,
} from 'naive-ui';
import ChatImagePreview from '@/components/ChatImagePreview.vue';
import GlobalPrivateCall from '@/components/GlobalPrivateCall.vue';
import {
  desktopShareStarting,
  desktopShareError,
  cancelDesktopScreenShare,
} from '@/services/desktopScreenShare';
import { auxiliaryContent as content } from '@/services/desktopAuxiliaryClient';
import { closeAuxiliaryWindow } from '@/services/desktopAuxiliaryContext';
import { usePrivateCallStore } from '@/stores/privateCall';
const call = usePrivateCallStore();
onBeforeUnmount(cancelDesktopScreenShare);
watch(
  () => call.busy,
  (busy, previous) => {
    if (previous && !busy) closeAuxiliaryWindow();
  },
  { flush: 'post' },
);
</script>
<style scoped>
.desktop-share-launch {
  position: fixed;
  inset: 0;
  z-index: 3001;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  background: #0b1220;
  color: #f8fafc;
}
.desktop-share-error {
  position: fixed;
  bottom: 20px;
  left: 20px;
  right: 20px;
  z-index: 3002;
  padding: 16px;
  background: #892d2d;
  color: white;
  border-radius: 8px;
}
.desktop-share-error button {
  float: right;
  margin-left: 16px;
}
</style>
