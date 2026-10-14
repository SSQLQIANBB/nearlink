<template>
  <div class="chat-text">{{ text }}</div>
</template>

<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<style scoped>
.chat-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
