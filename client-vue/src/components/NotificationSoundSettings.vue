<template>
  <section
    v-for="section in sections"
    :key="section.kind"
    class="sound-setting p-4 bg-gray-50 rounded-lg"
  >
    <div class="flex items-center justify-between gap-4">
      <div>
        <h3 class="font-semibold text-gray-800">{{ section.title }}</h3>
        <p class="text-sm text-gray-500 mt-1">{{ section.description }}</p>
      </div>
      <n-switch
        :value="settings[section.enabled]"
        :disabled="disabled"
        :aria-label="section.title"
        @update:value="update({ [section.enabled]: $event })"
      />
    </div>
    <div class="flex items-center gap-3 mt-4">
      <n-select
        class="flex-1 min-w-0"
        :aria-label="section.label"
        :value="settings[section.tone]"
        :options="[...section.options]"
        :disabled="disabled"
        @update:value="update({ [section.tone]: $event })"
      />
      <n-button
        secondary
        :aria-label="`试听${section.label}`"
        @click="preview(section.kind)"
      >
        <template #icon>
          <i
            class="iconfont"
            :class="previewing === section.kind ? 'icon-stop' : 'icon-play'"
            aria-hidden="true"
          ></i>
        </template>
        {{ previewing === section.kind ? '停止' : '试听' }}
      </n-button>
    </div>
  </section>
  <p class="text-xs text-gray-500">
    设置自动保存至当前账号，切换设备后同步。浏览器通知权限需在各设备单独授予。试听最多播放 6
    秒，不受静音开关影响。
  </p>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { NButton, NSelect, NSwitch, useMessage } from 'naive-ui';
import notificationService from '@/services/notificationService';
import {
  callTones,
  messageTones,
  type SoundKind,
  type SoundPreferences,
} from '@/services/notificationSounds';

const message = useMessage();
defineProps<{ settings: SoundPreferences; disabled: boolean }>();
const emit = defineEmits<{ update: [value: Partial<SoundPreferences>] }>();
const sections = [
  {
    kind: 'message',
    title: '消息提示音',
    description: '私聊、群聊消息及群组邀请的声音提醒',
    label: '消息提示音',
    enabled: 'messageEnabled',
    tone: 'messageTone',
    options: [...messageTones],
  },
  {
    kind: 'call',
    title: '来电铃声',
    description: '邀请等待期间循环播放，单人呼叫的发起方也会听到你选择的铃声',
    label: '来电铃声',
    enabled: 'callEnabled',
    tone: 'callTone',
    options: [...callTones],
  },
] as const;
const previewing = ref<SoundKind | null>(null);
let previewAudio: HTMLAudioElement | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

function stopPreview() {
  clearTimeout(previewTimer);
  if (previewAudio) {
    previewAudio.onended = null;
    previewAudio.pause();
    previewAudio = null;
  }
  previewing.value = null;
}

function update(value: Partial<SoundPreferences>) {
  stopPreview();
  emit('update', value);
}

async function preview(kind: SoundKind) {
  const wasPlaying = previewing.value === kind;
  stopPreview();
  if (wasPlaying) return;
  const audio = new Audio(notificationService.getSoundSource(kind));
  audio.volume = kind === 'call' ? 0.55 : 0.5;
  previewAudio = audio;
  previewing.value = kind;
  audio.onended = stopPreview;
  previewTimer = setTimeout(stopPreview, 6000);
  try {
    await audio.play();
  } catch {
    if (previewAudio !== audio) return;
    stopPreview();
    message.error('无法播放，请检查浏览器声音权限或稍后重试');
  }
}

onBeforeUnmount(stopPreview);
</script>
