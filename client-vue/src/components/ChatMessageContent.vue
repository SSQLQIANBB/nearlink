<template>
  <CallHistoryMessage
    v-if="messageType === 'call' && call"
    :record="call"
    :is-mine="isMine"
  />
  <div
    v-else
    class="message-bubble"
    :class="{
      'message-bubble--mine': isMine,
      'message-bubble--media': (messageType === 'image' || messageType === 'voice') && media,
      'message-bubble--image': messageType === 'image' && media,
    }"
  >
    <ChatImageMessage
      v-if="messageType === 'image' && media"
      :media="media"
      :is-mine="isMine"
    />
    <ChatVoiceMessage
      v-else-if="messageType === 'voice' && media"
      :media="media"
      :is-mine="isMine"
    />
    <ChatTextMessage
      v-else
      :text="message"
    />
  </div>
</template>

<script setup lang="ts">
import type { CallHistoryRecord, ChatMediaPayload, GroupHistoryMessage } from '@/api/message';
import CallHistoryMessage from './CallHistoryMessage.vue';
import ChatImageMessage from './ChatImageMessage.vue';
import ChatVoiceMessage from './ChatVoiceMessage.vue';
import ChatTextMessage from './ChatTextMessage.vue';

defineProps<{
  message: string;
  messageType?: GroupHistoryMessage['messageType'];
  media?: ChatMediaPayload;
  call?: CallHistoryRecord;
  isMine: boolean;
}>();
</script>

<style scoped>
.message-bubble {
  min-width: 92px;
  padding: 11px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
  color: #334155;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06);
  transition: box-shadow 0.2s ease;
}
.message-bubble:hover {
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.09);
}
.message-bubble--mine {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
  box-shadow: 0 7px 20px rgba(37, 99, 235, 0.18);
}
.message-bubble--media {
  padding: 6px 7px;
}
.message-bubble--image,
.message-bubble--image:hover {
  padding: 0;
  border: 0;
  background: transparent;
  color: #64748b;
  box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
  .message-bubble {
    transition: none;
  }
}
</style>
