<template>
  <aside v-if="host.phase !== 'offline'" class="remote-ui host-status" role="status" aria-label="本机远程协助">
    <strong>{{ host.phase === 'active' ? (host.scope === 'control' ? '对方正在远程查看与控制本机' : '对方正在远程查看本机') : host.phase === 'pending' ? '请在系统弹窗中确认协助请求' : '本机远程协助已开启' }}</strong>
    <span v-if="host.phase === 'online'">请求按本机已保存的允许范围确认</span>
    <n-button size="small" type="error" secondary @click="host.stop()">停止协助</n-button>
  </aside>
</template>
<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
const host = useRemoteControlHostStore();
</script>
<style scoped>

.host-status { position: fixed; top: 40px; left: 50%; transform: translateX(-50%); z-index: 5000; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 20px; background: #fff; color: #293548; border: 1px solid #e0e6ef; border-radius: 14px; box-shadow: 0 8px 32px #172b4d20; width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; }
.host-status strong { font-size: 14px; } .host-status span { color: #72839e; font-size: 12px; }

</style>
