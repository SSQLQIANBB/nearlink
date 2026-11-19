<template>
  <NButton v-bind="$attrs" :aria-label="label" :title="hint ? `${label}\n${hint}` : label">
    <template #icon><slot /></template>
  </NButton>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';

defineOptions({ inheritAttrs: false });
defineProps<{ label: string; hint?: string }>();
</script>
