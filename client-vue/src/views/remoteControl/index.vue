<template>
  <main class="remote-ui remote-control-page">
    <header>
      <n-button quaternary @click="router.push({ name: 'Remote' })">返回聊天</n-button>
      <h1>远程控制 <span class="remote-badge">内测版</span></h1>
      <p>远程查看与操作需要指定设备开启协助许可，由被控机按已保存的允许范围确认。</p>
    </header>
    <n-spin :show="remote.loading">
      <section class="status-card" aria-live="polite">
        <h2>{{ remote.canControl ? '主控环境检测通过' : '当前暂不可用' }}</h2>
        <p>{{ statusMessage }}</p>
        <dl v-if="remote.capabilities">
          <dt>当前环境</dt><dd>{{ remote.capabilities.runtime === 'tauri' ? '桌面客户端' : 'Web 浏览器' }}</dd>
          <dt>本机远程协助</dt><dd>{{ remote.capabilities.canHostView ? '可用' : '暂不可用' }}</dd>
          <dt>允许控制本机</dt><dd>{{ remote.capabilities.canHostControl ? '需本机确认后启用' : '不可用' }}</dd>
        </dl>
        <p class="note">浏览器可作为主控端；被控电脑需要安装支持远程协助的桌面客户端。屏幕共享不包含键鼠控制权限。</p>
        <n-button :loading="remote.loading" @click="refresh">重新检测</n-button>
      </section>
    </n-spin>
    <section v-if="remote.canControl" class="status-card">
      <h2>可请求协助的设备</h2>
      <p v-if="remote.error" role="alert">{{ remote.error }}</p>
      <p v-else-if="!remote.targets.length">暂无已获协助许可的设备。对方需要在桌面客户端为你的账号开启远程协助。</p>
      <ul v-else>
        <li v-for="target in remote.targets" :key="target.deviceId">
          <strong>{{ target.alias }}</strong> · {{ target.platform }} · {{ !target.online ? '离线' : target.busy ? '使用中' : '在线' }}
          <n-button size="small" :disabled="!target.online || target.busy || !target.canHostView || mediaBusy" @click="request(target, 'view')">请求观看</n-button>
          <n-button size="small" type="primary" :disabled="!target.online || target.busy || !target.canHostControl || mediaBusy" @click="request(target, 'control')">请求控制</n-button>
          <span v-if="!target.canHostControl" class="note">对方需开启辅助功能权限并重新检测，才能控制键盘鼠标。</span>
        </li>
      </ul>
      <p class="note">对方确认后才能观看；控制键盘鼠标需要单独许可。</p>
    </section>
    <section class="status-card"><RemoteDeviceSettings /></section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import RemoteDeviceSettings from '@/components/RemoteDeviceSettings.vue';
import { NButton, NSpin, useMessage } from 'naive-ui';
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { useRemoteControlSessionStore } from '@/stores/remoteControlSession';
import type { RemoteTarget } from '@/api/remoteControl';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { remoteCapabilityMessages } from '@/services/remoteControlCapabilities';
const router = useRouter();
const route = useRoute();
const remote = useRemoteControlStore();
const session = useRemoteControlSessionStore();
const message = useMessage();
const mediaBusy = computed(() => !!mediaOccupancy.current.value);
async function request(target: RemoteTarget, scope: 'view' | 'control') {
  try { await session.start(target, scope); }
  catch { message.error('暂时无法发起远程协助，请确认对方在线并已开启协助。'); }
}
const statusMessage = computed(() => remoteCapabilityMessages[remote.capabilities?.reason ?? 'RELEASE_UNAVAILABLE']);
async function refresh() {
  await remote.refreshCapabilities();
  const userId = Number(route.query.userId);
  if (Number.isSafeInteger(userId) && userId > 0) await remote.loadTargets(userId);
}
onMounted(() => { void refresh(); window.addEventListener('focus', refresh); });
onUnmounted(() => window.removeEventListener('focus', refresh));
</script>

<style scoped>
.remote-control-page { max-width: 1080px; margin: auto; padding: 32px 20px; color: #1e293b; }
header { margin-bottom: 24px; }
h1 { margin: 16px 0 8px; font-size: 28px; }
h2 { margin-bottom: 12px; font-size: 18px; }
p { line-height: 1.7; }
.status-card { padding: 24px; margin: 16px 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 12px; margin: 20px 0; }
dt, .note { color: #64748b; }
.note { font-size: 13px; margin: 16px 0; }
ul { padding: 0; list-style: none; display: grid; gap: 14px; }
li { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 20px; border: 1px solid #e0e6ef; border-radius: 12px; background: #f8fafd; overflow-wrap: anywhere; }
li strong { margin-right: auto; } li .note { flex-basis: 100%; margin: 0; }
h1 { display: flex; align-items: center; gap: 12px; }
.status-card > .note { background: #f0f6ff; border-radius: 10px; padding: 16px; }
@media (max-width: 600px) { .remote-control-page { padding: 20px 12px; } .status-card { padding: 18px; } dl { grid-template-columns: 1fr; gap: 6px; } dd { margin: 0 0 10px; } }
</style>
