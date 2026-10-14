<template>
  <div class="share-toolbar">
    <div
      class="share-toolbar__status"
      data-tauri-drag-region
    >
      <span
        class="share-toolbar__signal"
        aria-hidden="true"
      >
        ▂▅▇
      </span>
      <span data-tauri-drag-region>正在共享屏幕</span>
      <time>{{ elapsed }}</time>
    </div>
    <button
      class="share-toolbar__stop"
      @click="stop"
    >
      结束共享
    </button>
    <span
      v-if="error"
      class="share-toolbar__error"
      role="alert"
    >
      {{ error }}
    </span>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
const params = new URLSearchParams(location.search);
const token = Number(params.get('token'));
const seconds = ref(0);
const error = ref('');
const elapsed = computed(
  () =>
    `${Math.floor(seconds.value / 60)
      .toString()
      .padStart(2, '0')}:${(seconds.value % 60).toString().padStart(2, '0')}`,
);
const started = Date.now();
const timer = setInterval(() => {
  seconds.value = Math.floor((Date.now() - started) / 1000);
}, 1000);
async function stop() {
  try {
    await invoke('screen_share_stop', { token });
  } catch {
    error.value = '停止失败，请返回通话窗口重试';
  }
}
onBeforeUnmount(() => clearInterval(timer));
</script>
<style>
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
.share-toolbar {
  position: relative;
  box-sizing: border-box;
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 5px 7px 5px 12px;
  background: #242629;
  color: #f2f2f2;
  font:
    13px 'Microsoft YaHei',
    'PingFang SC',
    sans-serif;
  user-select: none;
}
.share-toolbar__status {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  cursor: move;
  white-space: nowrap;
}
.share-toolbar__signal {
  color: #00cd82;
  letter-spacing: 1px;
}
.share-toolbar time {
  font-size: 11px;
  color: #aaa;
  font-variant-numeric: tabular-nums;
}
.share-toolbar button {
  border: 0;
  border-radius: 4px;
  background: #3b3e42;
  color: white;
  height: 32px;
  padding: 0 9px;
  font: inherit;
  cursor: pointer;
}
.share-toolbar button:hover {
  filter: brightness(1.2);
}
.share-toolbar button:focus-visible {
  outline: 2px solid white;
}
.share-toolbar .share-toolbar__stop {
  background: #ed5551;
  padding: 0 12px;
  white-space: nowrap;
}
.share-toolbar__error {
  position: absolute;
  inset: 0 auto auto 0;
  background: #a72525;
  font-size: 10px;
}
</style>
