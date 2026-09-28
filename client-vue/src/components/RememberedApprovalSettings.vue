<template>
  <section aria-label="本机已记住的授权">
    <h4>本机已记住的授权</h4>
    <p>查看此前在本机确认窗口勾选“不再提示”的记录。恢复确认后，该记录不再用于自动批准；当前会话不受影响，需要立即结束时请点击“停止协助并离线”。</p>
    <n-button :loading="loading" :disabled="busy" @click="refresh">{{ loaded ? '刷新授权记录' : '查看授权记录' }}</n-button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loaded && !records.length">当前账号在本机没有可验证的记忆授权记录。</p>
    <ul v-if="records.length">
      <li v-for="record in records" :key="record.id">
        <div><strong>账号 {{ record.controllerUserId }}</strong> · {{ record.scope === 'control' ? '观看与键鼠控制' : '仅观看' }}<br /><small>被控设备：{{ record.hostDeviceId }}</small></div>
        <n-button size="small" :disabled="busy" @click="remove(record)">恢复对此记录的确认</n-button>
      </li>
    </ul>
    <p v-if="loaded" class="note">这些是已保存的确认记录，不代表当前在线或可连接。实际请求仍需通过账号、设备、协助许可及系统权限检查；本功能不提供开机前或登录前的无人值守访问。</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '@/stores/auth';
interface Approval { id: string; hostDeviceId: string; controllerUserId: number; scope: 'view' | 'control' }
const props = defineProps<{ resetVersion: number }>();
const auth = useAuthStore();
const records = ref<Approval[]>([]), loading = ref(false), removing = ref(false), loaded = ref(false);
const error = ref(''), notice = ref('');
const busy = computed(() => loading.value || removing.value);
let generation = 0, mounted = true;
function reset() { generation++; records.value = []; loaded.value = false; loading.value = removing.value = false; error.value = notice.value = ''; }
watch(() => [auth.currentUser?.id, auth.authGeneration, auth.loggingOut, props.resetVersion], reset);
function identity() {
  const userId = auth.currentUser?.id;
  return Number.isSafeInteger(userId) && userId! > 0 && !auth.loggingOut ? userId! : null;
}
function valid(value: unknown): value is Approval[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => item && typeof item === 'object'
    && /^[a-f0-9]{64}$/.test(item.id) && typeof item.hostDeviceId === 'string' && item.hostDeviceId.length <= 128
    && Number.isSafeInteger(item.controllerUserId) && item.controllerUserId > 0 && ['view', 'control'].includes(item.scope));
}
async function refresh() {
  if (busy.value) return;
  const userId = identity(); if (!userId) return;
  const current = ++generation; loading.value = true; error.value = notice.value = ''; records.value = []; loaded.value = false;
  try {
    const result = await invoke<unknown>('remote_control_list_remembered_approvals', { userId });
    if (!mounted || generation !== current || identity() !== userId) return;
    if (!valid(result)) throw new Error('invalid response');
    records.value = result.map(({ id, hostDeviceId, controllerUserId, scope }) => ({ id, hostDeviceId, controllerUserId, scope })); loaded.value = true;
  } catch {
    if (mounted && generation === current && identity() === userId) error.value = '无法读取本机授权记录，请确认设备身份可用并使用最新版桌面客户端。';
  } finally { if (generation === current) loading.value = false; }
}
async function remove(record: Approval) {
  if (busy.value || !records.value.some(item => item.id === record.id)) return;
  const userId = identity(); if (!userId) return;
  const current = ++generation; removing.value = true; error.value = notice.value = '';
  try {
    await invoke('remote_control_remove_remembered_approval', { userId, id: record.id });
    if (!mounted || generation !== current || identity() !== userId) return;
    records.value = records.value.filter(item => item.id !== record.id);
    notice.value = `已移除账号 ${record.controllerUserId} 的这条记忆记录，当前会话不会结束。`;
  } catch {
    if (mounted && generation === current && identity() === userId) error.value = '未能确认删除结果，请刷新授权记录；需要立即停止时请停止协助。';
  } finally { if (generation === current) removing.value = false; }
}
onUnmounted(() => { mounted = false; reset(); });
</script>
<style scoped>
section { display: grid; gap: 12px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; }
h4 { margin: 0; }
p { margin: 0; line-height: 1.7; }
ul { display: grid; gap: 12px; list-style: none; padding: 0; }
li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
small { overflow-wrap: anywhere; }
.note, small { color: #64748b; }
[role=alert] { color: #b91c1c; }
</style>
