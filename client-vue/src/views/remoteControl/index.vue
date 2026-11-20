<template>
  <main class="remote-control-page">
    <RemoteControlWorkbench />
  </main>
</template>
<script setup lang="ts">
import RemoteControlWorkbench from '@/components/RemoteControlWorkbench.vue';
</script>
<style scoped>
.remote-control-page {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  padding: 20px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.remote-control-page > :deep(.remote-workbench) { flex: 1; height: auto; min-height: 0; }
</style>
