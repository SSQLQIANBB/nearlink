<template>
  <n-card
    v-if="standalone"
    v-bind="$attrs"
    class="dialog-surface"
    :bordered="false"
    :closable="false"
  >
    <template
      v-for="(_, name) in $slots"
      #[name]="scope"
    >
      <slot
        :name="name"
        v-bind="scope || {}"
      />
    </template>
  </n-card>
  <n-modal
    v-else
    v-bind="$attrs"
  >
    <template
      v-for="(_, name) in $slots"
      #[name]="scope"
    >
      <slot
        :name="name"
        v-bind="scope || {}"
      />
    </template>
  </n-modal>
</template>
<script setup lang="ts">
import { NCard, NModal } from 'naive-ui';
defineOptions({ inheritAttrs: false });
defineProps<{ standalone?: boolean }>();
</script>
<style>
.dialog-surface.n-card {
  width: 100% !important;
  max-width: none !important;
  min-height: 100dvh;
  border-radius: 0;
  box-sizing: border-box;
}
</style>
