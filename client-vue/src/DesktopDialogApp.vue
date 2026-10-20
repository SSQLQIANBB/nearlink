<template>
  <n-config-provider class="desktop-dialog-viewport" :theme-overrides="appTheme">
    <n-message-provider>
      <n-dialog-provider><DesktopDialogContent /></n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui';
import { appTheme } from '@/theme';
import DesktopDialogContent from '@/components/DesktopDialogContent.vue';
</script>
<style>
html,
body,
#app {
  margin: 0;
  width: 100%;
  min-height: 100%;
}
body {
  color: #1e293b;
  background: #fff;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
.desktop-dialog-content {
  padding: 24px;
}
/* 主应用根节点隐藏溢出，独立窗口在自己的可视区域内滚动。 */
.desktop-dialog-viewport {
  height: 100dvh;
  overflow: auto;
}
.desktop-dialog-content h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 24px;
}
.desktop-dialog-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}
.desktop-dialog-content .n-input,
.desktop-dialog-content .n-select {
  min-width: 0;
}
</style>
