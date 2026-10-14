<template>
  <n-image
    class="chat-image"
    :class="{ 'chat-image--mine': isMine }"
    :src="resolvedUrl"
    :alt="media.fileName || '聊天图片'"
    object-fit="contain"
    preview-disabled
    :img-props="{
      onClick: () => (previewOpen = true),
      onKeydown: openWithKeyboard,
      tabindex: 0,
      role: 'button',
    }"
  >
    <template #placeholder>
      <span
        class="chat-image__status chat-image__loading"
        role="status"
      >
        图片加载中…
      </span>
    </template>
    <template #error>
      <span
        class="chat-image__status chat-image__error"
        role="status"
      >
        图片加载失败
      </span>
    </template>
  </n-image>
  <ChatImagePreview
    v-if="previewOpen"
    :src="resolvedUrl"
    :alt="media.fileName || '聊天图片'"
    @close="previewOpen = false"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NImage } from 'naive-ui';
import type { ChatMediaPayload } from '@/api/message';
import { resolveChatMediaUrl } from '@/services/chatMedia';
import ChatImagePreview from './ChatImagePreview.vue';

const props = defineProps<{ media: ChatMediaPayload; isMine: boolean }>();
const resolvedUrl = computed(() => resolveChatMediaUrl(props.media.url));
const previewOpen = ref(false);
function openWithKeyboard(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  previewOpen.value = true;
}
</script>

<style scoped>
/* 历史消息没有图片尺寸，固定预览区域避免资源加载改变消息高度。 */
.chat-image {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 320px;
  max-width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
}
.chat-image :deep(img) {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 10px;
}
.chat-image--mine {
  justify-content: flex-end;
}
.chat-image__status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: inherit;
  opacity: 0.7;
}
.chat-image:has(.chat-image__error) .chat-image__loading {
  display: none;
}
</style>
