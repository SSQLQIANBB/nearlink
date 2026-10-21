<template>
  <div
    v-if="status === 'loading'"
    class="history-loading"
    role="status"
    aria-label="获取消息中..."
  >
    <span>获取消息中</span>
    <span
      class="loading-dots"
      aria-hidden="true"
    >
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  </div>
  <div
    v-else-if="status === 'error'"
    class="history-error"
    role="status"
  >
    <span>消息获取失败</span>
    <button
      type="button"
      @click="$emit('retry')"
    >
      重新获取
    </button>
  </div>
  <div
    v-else-if="empty"
    class="message-empty"
    role="status"
  >
    <div
      class="message-empty-icon"
      aria-hidden="true"
    >
      <i class="iconfont icon-comments"></i>
    </div>
    <h3>还没有消息</h3>
    <p>{{ group ? '和群成员打个招呼，开启新的话题吧' : '发送第一条消息，开始你们的对话吧' }}</p>
    <span class="message-empty-hint">支持文字、图片和语音消息</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ status: 'loading' | 'ready' | 'error'; empty: boolean; group?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<style scoped>
.history-loading,
.history-error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 12px 16px;
  color: #64748b;
  font-size: 12px;
}
.loading-dots {
  display: inline-flex;
  margin-left: 2px;
}
.loading-dots span {
  display: inline-block;
  width: 5px;
  animation: message-dot-bounce 1.2s ease-in-out infinite;
}
.loading-dots span:nth-child(2) {
  animation-delay: 0.15s;
}
.loading-dots span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes message-dot-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
.history-error {
  gap: 10px;
}
.history-error button {
  color: #2563eb;
  background: none;
  border: 0;
  padding: 4px;
  cursor: pointer;
}
.message-empty {
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
}
.message-empty-icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-bottom: 18px;
  border: 1px solid #dbeafe;
  border-radius: 20px;
  background: #eff6ff;
  color: #3b82f6;
}
.message-empty-icon .iconfont {
  font-size: 30px;
}
.message-empty h3 {
  margin: 0 0 8px;
  color: #475569;
  font-size: 15px;
  font-weight: 600;
}
.message-empty p {
  margin: 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.7;
}
.message-empty-hint {
  margin-top: 10px;
  color: #94a3b8;
  font-size: 12px;
}
@media (prefers-reduced-motion: reduce) {
  .loading-dots span {
    animation: none;
  }
}
</style>
