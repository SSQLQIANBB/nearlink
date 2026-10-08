<template>
  <!-- 仅提供透明拖动热区；红黄绿按钮由 macOS 原生绘制。 -->
  <div v-if="isMac" class="desktop-window-drag-region" :class="{ 'desktop-window-drag-region--chat': isChat }" data-tauri-drag-region aria-hidden="true"></div>
  <div v-if="isMac && isChat" class="desktop-chat-top-drag-region" data-tauri-drag-region aria-hidden="true"></div>
  <template v-if="isWindows">
    <div class="desktop-windows-drag-region" :class="{ 'desktop-windows-drag-region--header': isChat || isCall }" aria-hidden="true"></div>
    <div class="desktop-window-controls" :class="{ 'desktop-window-controls--dark': isCall }" role="group" aria-label="窗口控制" data-no-drag>
      <button type="button" aria-label="最小化" title="最小化" @click="runWindowAction('minimize')">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg>
      </button>
      <button type="button" :aria-label="maximized ? '还原' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="runWindowAction('toggleMaximize')">
        <svg v-if="maximized" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5v-2h7v7h-2" /><rect x="1.5" y="3.5" width="7" height="7" /></svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
      </button>
      <button type="button" class="desktop-window-close" aria-label="关闭窗口" title="关闭窗口" @click="runWindowAction('close')">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { installDesktopWindowControls } from '@/services/desktopWindow';

const isMac = /Mac/.test(navigator.platform);
const isWindows = /Win/.test(navigator.platform);
const route = useRoute();
const isChat = computed(() => route.path === '/remote' || route.path.startsWith('/group-chat/'));
const isCall = computed(() => /^\/group-(video|audio|screen)\//.test(route.path));
const maximized = ref(false);
function runWindowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (!isTauri()) return;
  // close 继续交给原生 CloseRequested 处理，保留隐藏到托盘的行为。
  void getCurrentWindow()[action]().catch(error => console.warn('窗口操作失败', error));
}
let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = installDesktopWindowControls(isWindows ? value => { maximized.value = value; } : undefined);
});
onUnmounted(() => cleanup?.());
</script>

<style scoped>
.desktop-window-drag-region {
  position: fixed;
  inset: 0 0 auto;
  z-index: 20;
  height: 44px;
  background: transparent;
  user-select: none;
  cursor: default;
}

/* 聊天区只保留顶边拖动热区，不遮挡上移后的标题及群组操作。 */
.desktop-window-drag-region--chat {
  width: 320px;
}

.desktop-chat-top-drag-region {
  position: fixed;
  top: 0;
  left: 320px;
  right: 0;
  height: 8px;
  z-index: 20;
  user-select: none;
}

.desktop-windows-drag-region {
  position: fixed;
  inset: 0 138px auto 0;
  height: 32px;
  z-index: 20;
  user-select: none;
}
.desktop-windows-drag-region--header { height: 8px; }

.desktop-window-controls {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 3000;
  display: flex;
  height: 32px;
  color: #858b94;
  user-select: none;
}

.desktop-window-controls--dark { color: #cbd5e1; }
.desktop-window-controls button {
  display: grid;
  place-items: center;
  width: 46px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: default;
}
.desktop-window-controls button:hover { background: #80808022; }
.desktop-window-controls button:active { background: #80808033; }
.desktop-window-controls button:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
.desktop-window-controls .desktop-window-close:hover { background: #e81123; color: #fff; }
.desktop-window-controls .desktop-window-close:active { background: #c50f1f; color: #fff; }
.desktop-window-controls svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1; }
</style>
