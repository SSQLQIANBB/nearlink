<template>
  <button
    type="button"
    class="chat-voice"
    :class="{ 'chat-voice--mine': isMine, 'chat-voice--playing': playing }"
    :style="{ width: voiceWidth }"
    :aria-label="playing ? '暂停语音' : `播放 ${media.durationSeconds} 秒语音`"
    @click="togglePlayback"
  >
    <span
      class="chat-voice__wave"
      aria-hidden="true"
    >
      <i
        v-for="bar in 3"
        :key="bar"
      ></i>
    </span>
    <span class="chat-voice__duration">{{ media.durationSeconds }}″</span>
  </button>
  <audio
    ref="audioRef"
    :src="resolvedUrl"
    preload="metadata"
    hidden
    @play="playing = true"
    @pause="playing = false"
    @ended="handleEnded"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMediaPayload } from '@/api/message';
import { resolveChatMediaUrl } from '@/services/chatMedia';

const props = withDefaults(
  defineProps<{
    media: ChatMediaPayload;
    isMine?: boolean;
  }>(),
  { isMine: false },
);

const resolvedUrl = computed(() => resolveChatMediaUrl(props.media.url));
const audioRef = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const voiceWidth = computed(
  () => `${Math.min(220, 86 + (props.media.durationSeconds || 1) * 3)}px`,
);

function togglePlayback() {
  const audio = audioRef.value;
  if (!audio) return;
  if (!audio.paused) {
    audio.pause();
    return;
  }
  void audio.play().catch(() => {
    playing.value = false;
  });
}

function handleEnded() {
  playing.value = false;
  if (audioRef.value) audioRef.value.currentTime = 0;
}
</script>

<style scoped>
.chat-voice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 86px;
  min-height: 36px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.chat-voice--mine {
  flex-direction: row-reverse;
}

.chat-voice__wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 16px;
  flex: none;
}
.chat-voice__wave i {
  display: block;
  width: 2px;
  height: 12px;
  background: currentColor;
  border-radius: 2px;
}
.chat-voice__wave i:nth-child(2) {
  height: 16px;
}
.chat-voice__wave i:nth-child(3) {
  height: 8px;
}
.chat-voice:hover {
  opacity: 0.85;
}
.chat-voice__duration {
  flex: none;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.chat-voice--playing .chat-voice__wave i {
  animation: voice-wave 1s ease-in-out infinite;
}
.chat-voice--playing .chat-voice__wave i:nth-child(2) {
  animation-delay: 0.12s;
}
.chat-voice--playing .chat-voice__wave i:nth-child(3) {
  animation-delay: 0.24s;
}
@keyframes voice-wave {
  0%,
  100% {
    transform: scaleY(0.3);
  }
  50% {
    transform: scaleY(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-voice--playing .chat-voice__wave i {
    animation: none;
  }
}
</style>
