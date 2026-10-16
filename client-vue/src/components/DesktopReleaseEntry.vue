<template>
  <n-button
    size="small"
    secondary
    class="desktop-release-entry"
    @click="openDesktopRelease"
  >
    <span
      v-if="hasUpdate"
      class="update-dot"
      aria-hidden="true"
    />
    {{ desktop ? (hasUpdate ? '发现新版本' : '检查更新') : '下载桌面端' }}
  </n-button>
</template>
<script setup lang="ts">
import { NButton } from 'naive-ui';
import { desktop, hasUpdate, openDesktopRelease } from '@/services/desktopRelease';
</script>
<style scoped>
.desktop-release-entry {
  border-radius: 10px;
}
.update-dot {
  width: 6px;
  height: 6px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--n-text-color);
}
</style>
