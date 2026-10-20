<template>
  <div
    class="share-picker-backdrop"
    :class="{ 'share-picker-standalone': standalone }"
  >
    <section
      class="share-picker"
      role="dialog"
      aria-modal="true"
      aria-label="选择共享内容"
    >
      <header class="share-picker__header">
        <h1>共享屏幕</h1>
        <button
          class="share-picker__close"
          aria-label="取消共享"
          @click="cancel"
        >
          ×
        </button>
      </header>
      <div class="share-picker__content">
        <div class="share-picker__section-title">
          <h2>桌面</h2>
          <button
            @click="load"
            :disabled="loading || loadingPreviews"
          >
            刷新列表
          </button>
        </div>
        <p
          v-if="error"
          class="share-picker__error"
          role="alert"
        >
          {{ error }}
        </p>
        <p
          v-if="loading"
          class="share-picker__notice"
          role="status"
        >
          正在查找可共享的屏幕和窗口…
        </p>
        <div class="share-picker__grid">
          <button
            v-for="source in displays"
            :key="source.id"
            class="share-source"
            :class="{ 'is-selected': selected === source.id }"
            :aria-pressed="selected === source.id"
            :disabled="failed.has(source.id)"
            @click="selected = source.id"
          >
            <span class="share-source__preview">
              <img
                v-if="previews[source.id]"
                :src="previews[source.id]"
                alt=""
              />
              <span v-else>{{ failed.has(source.id) ? '无法共享此桌面' : '加载预览…' }}</span>
              <span
                v-if="selected === source.id"
                class="share-source__check"
              >
                ✓
              </span>
            </span>
            <span class="share-source__name">{{ source.name }}</span>
          </button>
        </div>
        <h2 class="share-picker__windows-title">应用窗口</h2>
        <nav
          class="share-picker__filters"
          aria-label="筛选应用"
        >
          <button
            v-for="app in apps"
            :key="app"
            :class="{ active: filter === app }"
            :aria-pressed="filter === app"
            @click="filter = app"
          >
            {{ app }}
          </button>
        </nav>
        <div class="share-picker__grid">
          <button
            v-for="source in windows"
            :key="source.id"
            class="share-source"
            :class="{ 'is-selected': selected === source.id }"
            :aria-pressed="selected === source.id"
            :disabled="failed.has(source.id)"
            @click="selected = source.id"
            :title="source.name"
          >
            <span class="share-source__preview">
              <img
                v-if="previews[source.id]"
                :src="previews[source.id]"
                alt=""
              />
              <span v-else>{{ failed.has(source.id) ? '无法共享此窗口' : '加载预览…' }}</span>
              <span
                v-if="selected === source.id"
                class="share-source__check"
              >
                ✓
              </span>
            </span>
            <span class="share-source__name">{{ source.name }}</span>
            <span class="share-source__app">{{ source.app }}</span>
          </button>
        </div>
        <p
          v-if="!loading && !windows.length"
          class="share-picker__notice"
        >
          没有可共享的应用窗口，请打开窗口后刷新列表。
        </p>
      </div>
      <footer class="share-picker__footer">
        <label>
          <input
            v-model="smooth"
            type="checkbox"
          />
          视频流畅度优先
        </label>
        <div>
          <button
            class="share-picker__cancel"
            @click="cancel"
          >
            取消
          </button>
          <button
            class="share-picker__start"
            :disabled="!selected || loading || failed.has(selected)"
            @click="selectSource"
          >
            开始共享
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { screenPicker, type DesktopShareSource } from '@/services/desktopScreenShare';
const props = defineProps<{
  standalone?: boolean;
  request?: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
}>();
const emit = defineEmits<{ select: [value: { id: string; smooth: boolean }]; cancel: [] }>();
const request = <T,>(name: string, args?: Record<string, unknown>): Promise<T> =>
  (props.request || invoke)<T>(name, args);
function selectSource() {
  const selection = { id: selected.value, smooth: smooth.value };
  if (props.standalone) emit('select', selection);
  else screenPicker.value?.select(selection);
}
const sources = ref<DesktopShareSource[]>([]);
const previews = ref<Record<string, string>>({});
const failed = ref(new Set<string>());
const selected = ref('');
const filter = ref('全部');
const smooth = ref(false);
const loading = ref(false);
const loadingPreviews = ref(false);
const error = ref('');
let generation = 0;
const displays = computed(() => sources.value.filter((s) => s.kind === 'display'));
const apps = computed(() => [
  '全部',
  ...new Set(sources.value.filter((s) => s.kind === 'window').map((s) => s.app)),
]);
const windows = computed(() =>
  sources.value.filter(
    (s) => s.kind === 'window' && (filter.value === '全部' || s.app === filter.value),
  ),
);
function cancel() {
  if (props.standalone) emit('cancel');
  else screenPicker.value?.cancel();
}
function clearPreviews() {
  Object.values(previews.value).forEach(URL.revokeObjectURL);
  previews.value = {};
  failed.value = new Set();
}
async function load() {
  const attempt = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const list = await request<DesktopShareSource[]>('screen_share_sources');
    if (attempt !== generation) return;
    clearPreviews();
    sources.value = list;
    if (!list.some((s) => s.id === selected.value)) selected.value = list[0]?.id || '';
    if (!apps.value.includes(filter.value)) filter.value = '全部';
    loading.value = false;
    loadingPreviews.value = true;
    // One capture at a time avoids overwhelming native capture/IPC with many windows.
    for (const source of list) {
      try {
        const bytes = await request<ArrayBuffer | number[]>('screen_share_preview', {
          id: source.id,
        });
        if (attempt !== generation) return;
        previews.value[source.id] = URL.createObjectURL(
          new Blob([Array.isArray(bytes) ? new Uint8Array(bytes) : bytes], { type: 'image/jpeg' }),
        );
      } catch {
        if (attempt !== generation) return;
        failed.value.add(source.id);
      }
    }
  } catch (cause) {
    if (attempt !== generation) return;
    error.value = `无法读取共享源：${String(cause)}`;
  } finally {
    if (attempt === generation) {
      loading.value = false;
      loadingPreviews.value = false;
    }
  }
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') cancel();
}
onMounted(() => {
  void load();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  generation++;
  clearPreviews();
  window.removeEventListener('keydown', onKey);
});
</script>
<style scoped>
.share-picker-backdrop.share-picker-standalone {
  padding: 0;
}
.share-picker-standalone .share-picker {
  height: 100%;
  max-width: none;
  border: 0;
  border-radius: 0;
}
.share-picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: #222;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #f1f1f1;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
.share-picker {
  width: 100%;
  max-width: 1160px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: #2d2d2d;
  border: 1px solid #454545;
  border-radius: 12px;
  box-shadow: 0 16px 70px #0005;
  overflow: hidden;
}
.share-picker button {
  font: inherit;
  cursor: pointer;
}
.share-picker button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 4px;
}
.share-picker button:disabled {
  opacity: 0.45;
  cursor: default;
}
.share-picker__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 28px 0;
  border-bottom: 1px solid #444;
}
.share-picker__header h1 {
  font-size: 22px;
  font-weight: 600;
  padding: 0 0 18px;
  margin: 0;
  border-bottom: 3px solid #338bff;
}
.share-picker__close {
  align-self: flex-start;
  font-size: 30px !important;
  line-height: 1;
  color: #aaa;
  background: none;
  border: 0;
}
.share-picker__content {
  overflow: auto;
  min-height: 0;
  flex: 1;
  padding: 22px 28px;
}
.share-picker h2 {
  font-size: 15px;
  color: #c7c7c7;
  margin: 0;
  font-weight: 500;
}
.share-picker__section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.share-picker__section-title button {
  background: none;
  border: 0;
  color: #80b5ff;
  font-size: 13px;
}
.share-picker__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px 22px;
}
.share-source {
  min-width: 0;
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  text-align: center;
}
.share-source__preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16/10;
  border: 2px solid #474747;
  border-radius: 6px;
  background: #252525;
  overflow: hidden;
  padding: 12px;
  color: #969696;
  font-size: 12px;
}
.share-source:hover .share-source__preview {
  border-color: #777;
}
.share-source.is-selected .share-source__preview {
  border: 3px solid #338bff;
  background: #303844;
  padding: 11px;
}
.share-source__preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.share-source__check {
  position: absolute;
  right: 6px;
  bottom: 6px;
  border-radius: 50%;
  background: #338bff;
  color: white;
  width: 22px;
  height: 22px;
  font-size: 16px;
  line-height: 22px;
}
.share-source__name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 10px;
  font-size: 15px;
}
.share-source__app {
  display: block;
  color: #999;
  font-size: 12px;
  margin-top: 3px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.share-picker__windows-title {
  margin-top: 26px !important;
}
.share-picker__filters {
  display: flex;
  gap: 8px;
  overflow: auto;
  padding: 12px;
  margin: 12px 0 22px;
  background: #3a3a3a;
  border-radius: 8px;
}
.share-picker__filters button {
  flex-shrink: 0;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #bbb;
  padding: 8px 14px;
  font-size: 13px;
}
.share-picker__filters button.active {
  color: #fff;
  background: #525252;
  box-shadow: inset 0 -2px #338bff;
}
.share-picker__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 28px;
  border-top: 1px solid #444;
  background: #303030;
}
.share-picker__footer label {
  display: flex;
  gap: 9px;
  align-items: center;
  font-size: 14px;
  color: #ddd;
}
.share-picker__footer input {
  accent-color: #338bff;
  width: 16px;
  height: 16px;
}
.share-picker__footer > div {
  display: flex;
  gap: 12px;
}
.share-picker__footer button {
  border: 0;
  border-radius: 5px;
  padding: 10px 25px;
}
.share-picker__cancel {
  background: #444;
  color: #eee;
}
.share-picker__start {
  background: #338bff;
  color: white;
  min-width: 126px;
}
.share-picker__notice {
  color: #aaa;
  font-size: 14px;
  padding: 10px 0;
}
.share-picker__error {
  color: #ffb0a7;
  font-size: 14px;
}
@media (max-width: 750px) {
  .share-picker-backdrop {
    padding: 12px;
  }
  .share-picker__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .share-picker__content {
    padding: 16px;
  }
  .share-picker__footer {
    padding: 14px 16px;
  }
  .share-picker__footer button {
    padding: 10px 16px;
  }
}
</style>
