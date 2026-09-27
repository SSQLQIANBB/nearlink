<template>
  <aside v-if="host.phase !== 'offline'" class="host-status" role="status" aria-label="本机远程协助">
    <strong>{{ host.phase === 'active' ? (host.scope === 'control' ? '对方正在远程查看与控制本机' : '对方正在远程查看本机') : host.phase === 'pending' ? '请在系统弹窗中确认协助请求' : '本机远程协助已开启' }}</strong>
    <span v-if="host.phase === 'online'">每次连接均需你在本机确认</span>
    <n-button size="small" type="error" @click="host.stop()">停止协助</n-button>
  </aside>
</template>
<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
const host = useRemoteControlHostStore();
</script>
<style scoped>
.host-status { position: fixed; top: 40px; left: 50%; transform: translateX(-50%); z-index: 5000; display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #fff7ed; color: #9a3412; border: 1px solid #fdba74; border-radius: 10px; box-shadow: 0 4px 20px #0002; max-width: 95vw; }
.host-status span { font-size: 12px; }
</style>
