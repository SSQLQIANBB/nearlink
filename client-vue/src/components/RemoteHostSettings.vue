<template>
  <section aria-label="本机协助设置">
    <h3>开启本机协助</h3>
    <p>选择本机登记的设备和允许请求协助的联系人。可选择临时或长期许可。首次连接需在本机确认；勾选“不再提示”并允许后，同一请求账号在已允许范围内的后续请求可自动批准。</p>
    <n-select v-model:value="selectedDevice" :options="deviceOptions" placeholder="选择本机登记的设备" :disabled="host.phase !== 'offline'" />
    <n-select v-model:value="controller" :options="contacts" placeholder="选择允许协助的账号" />
    <n-select v-model:value="duration" :options="durationOptions" aria-label="协助许可有效期" :disabled="busy" />
    <p v-if="duration === 'permanent'">长期许可允许该账号持续发起请求；是否自动批准取决于你是否在确认窗口勾选“不再提示”并允许。手动撤销、退出授权账号或撤销设备后失效。</p>
    <div class="actions">
      <n-button :disabled="!selectedDevice || !controller || busy" :loading="busy" @click="grant">允许请求协助</n-button>
      <n-button v-if="host.phase === 'offline'" type="primary" :disabled="!selectedDevice" @click="host.start(selectedDevice!)">本机上线</n-button>
      <n-button v-else type="error" @click="host.stop()">停止协助并离线</n-button>
    </div>
    <div class="actions">
      <n-button :disabled="resetting" :loading="resetting" @click="resetConfirmations">恢复每次确认</n-button>
      <span>清除本机记住的协助允许选项，不会结束当前会话。</span>
    </div>
    <RememberedApprovalSettings :reset-version="consentListVersion" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!remote.capabilities?.canHostView">请先在 macOS 系统设置中为 ToDesk 开启屏幕录制权限；键鼠控制还需要辅助功能权限。更改权限后重新启动客户端。</p>
    <section aria-label="键鼠控制权限">
      <strong>客户端支持键鼠控制，须经本机允许</strong>
      <p>{{ remote.capabilities?.canHostControl ? '系统权限已就绪，对方可以请求控制。' : '尚未具备键鼠控制权限。请为 /Applications/ToDesk.app 开启屏幕录制和辅助功能权限，再重新检测。' }}</p>
      <n-button @click="openPermission('screenCapture')">打开屏幕录制设置</n-button>
      <n-button @click="openPermission('inputControl')">打开辅助功能设置</n-button>
      <n-button :loading="remote.loading" @click="refreshPermissions">重新检测权限</n-button>
    </section>
    <p v-if="host.error || error" role="alert">{{ host.error || error }}</p>
    <ul>
      <li v-for="item in grants" :key="item.id">
        {{ deviceOptions.find(d => d.value === item.hostDeviceId)?.label || '设备' }} → {{ contacts.find(c => c.value === item.controllerUserId)?.label || `账号 ${item.controllerUserId}` }}
        （{{ item.expiresAt ? new Date(item.expiresAt).toLocaleString() + ' 到期' : '长期有效，直到撤销' }}）
        <n-button size="small" :disabled="busy" @click="revoke(item.id)">撤销许可</n-button>
      </li>
    </ul>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import RememberedApprovalSettings from './RememberedApprovalSettings.vue';
import { invoke } from '@tauri-apps/api/core';
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { useSocketStore } from '@/stores/socket';
import { useAuthStore } from '@/stores/auth';
import { createAssistanceGrant, getAssistanceGrants, revokeAssistanceGrant, type AssistanceGrant, type AssistanceDuration, type RemoteDevice } from '@/api/remoteControl';
const props = defineProps<{ devices: RemoteDevice[] }>();
const host = useRemoteControlHostStore(), remote = useRemoteControlStore(), socket = useSocketStore(), auth = useAuthStore();
const selectedDevice = ref<string | null>(null), controller = ref<number | null>(null);
const resetting = ref(false), notice = ref('');
const consentListVersion = ref(0);
const busy = ref(false), error = ref(''), grants = ref<AssistanceGrant[]>([]);
const duration = ref<AssistanceDuration>('15m');
const durationOptions = [{ label: '15 分钟', value: '15m' }, { label: '1 小时', value: '1h' }, { label: '长期有效，直到手动撤销', value: 'permanent' }];
let mounted = true;
async function openPermission(permission: 'screenCapture' | 'inputControl') {
  try { await invoke('remote_control_open_permission_settings', { permission }); }
  catch { error.value = '无法打开设置，请在系统设置 → 隐私与安全性中为 ToDesk 开启对应权限。'; }
}
async function refreshPermissions() {
  await remote.refreshCapabilities();
  if (!remote.capabilities?.canHostControl) error.value = '辅助功能权限尚未生效。若已开启，请核对应用路径并重启 ToDesk；更新安装包后可能需要重新授权。';
  else error.value = '';
}
const deviceOptions = computed(() => props.devices.filter(d => !d.revokedAt && d.platform === 'macos').map(d => ({ label: d.alias, value: d.deviceId })));
const contacts = computed(() => [...(auth.currentUser ? [{ label: '当前账号的另一台电脑', value: auth.currentUser.id }] : []), ...socket.userList.map(u => ({ label: u.username, value: u.id }))]);
async function refresh() { const result = await getAssistanceGrants(); if (mounted) grants.value = result.grants; }
async function grant() {
  if (!selectedDevice.value || !controller.value || busy.value) return;
  busy.value = true; error.value = '';
  try { await createAssistanceGrant(selectedDevice.value, controller.value, duration.value); await refresh(); }
  catch { error.value = '未能开启协助许可，请刷新后重试。'; }
  finally { busy.value = false; }
}
async function resetConfirmations() {
  if (resetting.value) return;
  resetting.value = true; error.value = ''; notice.value = '';
  try {
    await invoke('remote_control_clear_remembered_approvals');
    if (mounted) { consentListVersion.value++; notice.value = '已恢复每次确认，下次协助请求将重新弹窗。'; }
  } catch {
    if (mounted) error.value = '未能清除记住的允许选项，请重试。';
  } finally { resetting.value = false; }
}
async function revoke(id: string) {
  busy.value = true; error.value = '';
  try { await revokeAssistanceGrant(id); await refresh(); }
  catch { error.value = '未能确认撤销结果。需要立即结束时请点击停止协助。'; }
  finally { busy.value = false; }
}
onMounted(() => { void refresh().catch(() => { error.value = '暂时无法读取协助许可。'; }); });
onUnmounted(() => { mounted = false; });
</script>
<style scoped>
section { display: grid; gap: 12px; padding: 18px 0; }
p, li { line-height: 1.7; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
[role=alert] { color: #b91c1c; }
</style>
