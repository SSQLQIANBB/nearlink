<template>
  <n-config-provider class="desktop-dialog-viewport" :theme-overrides="dialogTheme">
    <n-message-provider>
      <n-dialog-provider><DesktopDialogContent /></n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui';
import { appTheme } from '@/theme';
import DesktopDialogContent from '@/components/DesktopDialogContent.vue';
import { onMounted, onBeforeUnmount } from 'vue';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

const dialogTheme = { ...appTheme, common: { ...appTheme.common, borderRadius: '8px' } };

let observer: ResizeObserver | undefined;
let frame = 0;
let disposed = false;
let resizing = false;
let content: HTMLElement | null = null;
let lastHeight = 0;
let lastWidth = 0;

function scheduleResize() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => void fitContent());
}

async function fitContent() {
  if (disposed || resizing || !content) return;
  // 测量自然内容高度，不测量占满窗口的 viewport，避免窗口越撑越高。
  const height = Math.min(
    Math.ceil(content.getBoundingClientRect().height),
    Math.max(180, screen.availHeight - 80),
  );
  const target = Math.max(180, height);
  const width = window.innerWidth;
  if (Math.abs(window.innerHeight - target) < 2 || (lastHeight === target && lastWidth === width))
    return;
  resizing = true;
  try {
    await getCurrentWindow().setSize(new LogicalSize(width, target));
    lastHeight = target;
    lastWidth = width;
  } catch (error) {
    console.error('调整弹窗尺寸失败', error);
    return;
  } finally {
    resizing = false;
  }
  // 原生调整期间表单校验或列表加载可能改变内容，再核对一次最新高度。
  if (!disposed) scheduleResize();
}

onMounted(() => {
  content = document.querySelector('.desktop-dialog-content');
  if (!content) return;
  observer = new ResizeObserver(scheduleResize);
  observer.observe(content);
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
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
  padding: 20px 24px 0;
  display: flow-root;
}
/* 主应用根节点隐藏溢出，独立窗口在自己的可视区域内滚动。 */
.desktop-dialog-viewport {
  height: 100dvh;
  overflow: auto;
}
.desktop-dialog-content h1 {
  font-size: 18px;
  line-height: 28px;
  font-weight: 600;
  margin: 0 0 20px;
  overflow-wrap: anywhere;
}
.desktop-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin: 20px -24px 0;
  padding: 16px 24px;
  border-top: 1px solid #eef0f4;
  background: #f8fafc;
  flex-wrap: wrap;
}
.desktop-dialog-actions .n-button {
  min-width: 80px;
}
.desktop-dialog-content .n-input,
.desktop-dialog-content .n-select {
  min-width: 0;
}
</style>
