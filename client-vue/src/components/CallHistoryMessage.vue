<template>
  <div
    class="call-history-message"
    :class="{ 'call-history-message--mine': isMine }"
  >
    <i
      class="iconfont text-blue-600"
      :class="
        record.type === 'screen'
          ? 'icon-gongxiangpingmu'
          : record.type === 'audio'
            ? 'icon-phone'
            : 'icon-video'
      "
      aria-hidden="true"
    ></i>
    <div class="call-history-message__content">
      <strong>{{ presentation.title }}</strong>
      <span>{{ presentation.detail }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CallHistoryRecord } from '@/api/message';
import { getCallHistoryPresentation } from '@/services/callHistory';

const props = defineProps<{
  record: CallHistoryRecord;
  isMine: boolean;
}>();

const presentation = computed(() => getCallHistoryPresentation(props.record, props.isMine));
</script>

<style scoped>
.call-history-message {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
  color: #334155;
  box-shadow: 0 2px 8px rgb(15 23 42 / 8%);
}

.call-history-message--mine {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1e40af;
}

.call-history-message__content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.call-history-message > .iconfont {
  font-size: var(--icon-size-control);
}

.call-history-message__content strong {
  font-size: 12px;
  line-height: 20px;
}

.call-history-message__content span {
  color: #64748b;
  font-size: 10px;
  line-height: 16px;
}
</style>
