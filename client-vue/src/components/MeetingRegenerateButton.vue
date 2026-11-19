<script setup lang="ts">
import { NTooltip } from 'naive-ui';
defineProps<{ disabled?: boolean; label: string }>();
const emit = defineEmits<{ regenerate: [] }>();
</script>

<template>
  <NTooltip placement="left">
    <template #trigger>
      <button class="regenerate-button" type="button" :disabled="disabled" :aria-label="label" @click="emit('regenerate')">
        <span aria-hidden="true" />
      </button>
    </template>
    {{ label }}
  </NTooltip>
</template>

<style scoped>
.regenerate-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #fff;
  color: #24292b;
}
.regenerate-button span { width: 16px; height: 16px; background: currentColor; mask: url('@/assets/meeting/regenerate.svg') center / contain no-repeat; }
.regenerate-button:not(:disabled):hover { background: #f3f7fc; color: #137fff; }
.regenerate-button:disabled { color: #a8adb4; cursor: default; }
.regenerate-button:focus-visible { outline: 2px solid #137fff; outline-offset: 1px; }
</style>
