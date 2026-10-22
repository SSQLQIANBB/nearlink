<template><span v-if="false" /></template>
<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useMessage } from 'naive-ui';
import { installDesktopAuxiliaryHost } from '@/services/desktopAuxiliaryWindows';
const message = useMessage();
const dispose = installDesktopAuxiliaryHost(
  (error) => message.error(`无法打开独立窗口：${String(error)}`),
  true,
);
onBeforeUnmount(dispose);
</script>
