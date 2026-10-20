<template>
  <button
    v-if="variant === 'sidebar'"
    type="button"
    class="desktop-download-card"
    :aria-label="desktop ? '检查更新' : '下载桌面端'"
    @click="openDesktopRelease"
  >
    <i
      class="iconfont icon-desktop desktop-download-icon"
      aria-hidden="true"
    ></i>
    <span class="desktop-download-copy">
      <strong>NearLink 桌面端</strong>
      <span>{{ desktop ? (hasUpdate ? '发现新版本' : '检查更新') : '获取桌面内测版' }}</span>
    </span>
    <i
      :class="['iconfont', desktop ? 'icon-refresh' : 'icon-download']"
      aria-hidden="true"
    ></i>
  </button>
  <n-button
    v-else
    :size="size"
    type="primary"
    secondary
    class="desktop-release-entry"
    @click="openDesktopRelease"
  >
    <template #icon>
      <i
        :class="['iconfont', desktop ? 'icon-refresh' : 'icon-download']"
        aria-hidden="true"
      ></i>
    </template>
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
withDefaults(defineProps<{ variant?: 'button' | 'sidebar'; size?: 'small' | 'medium' }>(), {
  variant: 'button',
  size: desktop ? 'small' : 'medium',
});
</script>
<style scoped>
.desktop-release-entry {
  border-radius: 10px;
}
.desktop-download-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 12px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #eff6ff;
  color: #2563eb;
  text-align: left;
  cursor: pointer;
  transition:
    background 150ms,
    border-color 150ms;
}
.desktop-download-card:hover {
  background: #e0edff;
  border-color: #bfdbfe;
}
.desktop-download-card:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.desktop-download-icon {
  font-size: 24px;
}
.desktop-download-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.desktop-download-copy strong {
  font-size: 14px;
  font-weight: 600;
  color: #1e40af;
}
.desktop-download-copy > span {
  font-size: 12px;
  color: #64748b;
}
.update-dot {
  width: 6px;
  height: 6px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--n-text-color);
}
</style>
