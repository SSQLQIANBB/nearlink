<template>
  <main class="remote-control-page">
    <n-button quaternary @click="router.push({ name: 'Remote' })">返回聊天</n-button>
    <RemoteControlWorkbench />
  </main>
</template>
<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useRouter } from 'vue-router';
import RemoteControlWorkbench from '@/components/RemoteControlWorkbench.vue';
const router = useRouter();
</script>
<style scoped>
.remote-control-page {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 1280px;
  margin: auto;
  padding: 20px;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.remote-control-page > .n-button { flex: none; align-self: flex-start; }
.remote-control-page > :deep(.remote-workbench) { flex: 1; height: auto; min-height: 0; }
</style>
