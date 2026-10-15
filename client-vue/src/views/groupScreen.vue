<template>
  <ScreenShare
    :key="scopeKey"
    :scope="scope"
  />
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ScreenShare from '@/features/screenShare/ScreenShare.vue';
import type { ScreenShareScope } from '@/features/screenShare/api';
const route = useRoute();
const scope = computed<ScreenShareScope>(() =>
  route.params.kind === 'private'
    ? { kind: 'private', peerId: Number(route.params.id) }
    : { kind: 'group', id: Number(route.params.id) },
);
const scopeKey = computed(() => `${scope.value.kind}:${route.params.id}`);
</script>
