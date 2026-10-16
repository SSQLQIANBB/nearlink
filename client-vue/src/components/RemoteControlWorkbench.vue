<template>
  <section class="remote-workbench" aria-label="远程控制">
    <header class="workbench-heading">
      <h2>允许控制本设备</h2>
      <n-switch :value="host.phase !== 'offline'" :loading="preparing || host.phase === 'starting'"
        :disabled="preparing || devices.busy || (host.phase === 'offline' && !remote.capabilities?.canHostView)"
        aria-label="开启本机协助" @update:value="toggleHost" />
      <n-button v-if="!remote.capabilities?.canHostView" class="refresh-capabilities" text type="primary"
        :disabled="remote.loading" :aria-busy="remote.loading" @click="remote.refreshCapabilities()">
        <template #icon><i class="iconfont icon-refresh" :class="{ 'is-refreshing': remote.loading }" aria-hidden="true" /></template>
        刷新可用状态
      </n-button>
    </header>
    <div class="credentials-card">
      <div class="credential-field">
        <span class="field-label">设备代码</span>
        <div class="credential-value">
          <strong>{{ formattedCode }}</strong>
          <button type="button" aria-label="复制设备代码" :disabled="!host.displayedDeviceCode" @click="copy(host.displayedDeviceCode)">
            <i class="iconfont icon-copy1" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="credential-field password-field">
        <span class="field-label">临时密码</span>
        <div class="credential-value">
          <strong>{{ !host.credentials ? '—' : expired ? '已过期' : passwordVisible ? host.credentials.temporaryPassword : '••••••••••' }}</strong>
          <button type="button" :aria-label="passwordVisible ? '隐藏密码' : '显示密码'" :disabled="!validCredentials" @click="passwordVisible = !passwordVisible">
            <i :class="['iconfont', passwordVisible ? 'icon-hide_password' : 'icon-show_password']" aria-hidden="true" />
          </button>
          <button type="button" aria-label="刷新临时密码" :disabled="host.phase !== 'online' || host.refreshingCredentials" @click="refreshPassword">
            <i class="iconfont icon-refresh" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
    <div class="credential-actions">
      <span>{{ host.credentials ? expired ? '临时密码已过期，请刷新后分享。' : '临时密码有效期 15 分钟；停止协助后连接信息失效。' : '开启本机协助后，生成设备代码和临时密码。' }}</span>
      <n-button text type="primary" :disabled="!validCredentials" @click="share">复制连接信息</n-button>
    </div>
    <p v-if="host.error || devices.error" role="alert" class="error">{{ host.error || devices.error }}</p>
    <div v-if="!remote.capabilities?.canHostView" class="hint" role="status">
      <p>{{ capabilityMessage }}</p>
    </div>
    <div v-if="remote.capabilities?.native?.platform === 'macos'" class="permission-actions">
      <n-button text @click="openPermission('screenCapture')">屏幕录制权限</n-button>
      <n-button text @click="openPermission('inputControl')">辅助功能权限</n-button>
      <n-button text @click="remote.refreshCapabilities()">刷新权限状态</n-button>
    </div>
    <div v-if="host.session" class="session-strip" role="status">
      {{ host.phase === 'pending' ? '等待本机确认' : host.phase === 'connecting' ? '正在建立连接' : '对方正在协助本机' }}
      <n-button type="error" secondary @click="host.stop()">结束协助</n-button>
    </div>
    <form class="connection-form" @submit.prevent="connect">
      <h2>远程控制设备</h2>
      <p v-if="!remote.capabilities?.canControl" class="hint">{{ remote.loading && !remote.capabilities ? '正在获取远控状态…' : remoteCapabilityMessages[remote.capabilities?.reason ?? 'RELEASE_UNAVAILABLE'] }}</p>
      <div class="connection-fields">
        <n-input v-model:value="deviceCode" aria-label="对方设备代码" placeholder="请输入对方设备代码" :maxlength="11" :disabled="session.visible" />
        <n-input v-model:value="temporaryPassword" type="password" show-password-on="click" aria-label="对方临时密码" placeholder="请输入临时密码" :maxlength="10" :disabled="session.visible" autocomplete="off" />
        <n-button type="primary" attr-type="submit" :disabled="!canConnect" :loading="connecting">连接</n-button>
      </div>
      <n-radio-group v-model:value="requestedScope" aria-label="连接方式">
        <n-radio value="control">远程控制</n-radio><n-radio value="view">仅观看</n-radio>
      </n-radio-group>
      <div v-if="session.visible" class="session-strip" role="status">
        {{ session.statusMessage }}
        <n-button secondary @click="session.end('REMOTE_LOCAL_END')">{{ session.phase === 'active' ? '结束连接' : '取消连接' }}</n-button>
      </div>
      <p v-if="connectionError" role="alert" class="error">{{ connectionError }}</p>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { NButton, NInput, NRadio, NRadioGroup, NSwitch, useMessage } from 'naive-ui';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
import { useRemoteControlSessionStore } from '@/stores/remoteControlSession';
import { useRemoteDevicesStore } from '@/stores/remoteDevices';
import { remoteCapabilityMessages } from '@/services/remoteControlCapabilities';

const remote = useRemoteControlStore(), host = useRemoteControlHostStore();
const session = useRemoteControlSessionStore(), devices = useRemoteDevicesStore();
const message = useMessage();
const deviceCode = ref(''), temporaryPassword = ref(''), passwordVisible = ref(false);
const requestedScope = ref<'control' | 'view'>('control'), connectionError = ref('');
const connecting = ref(false), now = ref(Date.now());
const normalizedCode = computed(() => deviceCode.value.replace(/\s/g, ''));
const formattedCode = computed(() => host.displayedDeviceCode.replace(/(\d{3})(?=\d)/g, '$1 ') || '—');
const expired = computed(() => !!host.credentials && now.value >= host.credentials.expiresAt);
const validCredentials = computed(() => !!host.credentials && !expired.value);
const canConnect = computed(() => remote.canControl && !session.visible && !connecting.value &&
  /^\d{9}$/.test(normalizedCode.value) && /^[a-z2-9]{10}$/.test(temporaryPassword.value));
const capabilityMessage = computed(() => {
  const capability = remote.capabilities;
  // 焦点刷新沿用已有能力说明，避免临时 loading 改变内容高度；连接门禁仍使用 canControl。
  if (remote.loading && !capability) return '正在获取远控状态…';
  if (capability?.runtime === 'tauri' && !capability.native) return '无法读取本机远控能力，请重新启动桌面客户端后重试。';
  if (capability?.native?.reason === 'PLATFORM_UNSUPPORTED') return '本机被控当前支持 Windows 11 x64 或 macOS 13 及以上的 Apple 芯片设备。';
  if (capability?.native?.reason === 'REMOTE_ENGINE_NOT_CONFIGURED') return '此桌面程序未编入远控引擎，需要使用包含对应平台引擎的版本并重新启动。刷新页面无法加载引擎。';
  if (capability?.native && !capability.native.engineReady) return '本机远控引擎未就绪，请重新启动包含引擎的桌面版本；若仍失败，请检查引擎资源与启动状态。';
  if (capability?.native?.permissions?.screenCapture !== 'granted' && capability?.runtime === 'tauri')
    return capability.native?.platform === 'macos' ? '请开启屏幕录制权限，再刷新权限状态。' : '请解锁电脑并返回正常桌面后重试。';
  return remoteCapabilityMessages[capability?.reason ?? 'RELEASE_UNAVAILABLE'];
});
watch(() => host.credentials, () => { passwordVisible.value = false; });
const preparing = ref(false);
let disposed = false;
async function toggleHost(enabled: boolean) {
  if (!enabled) { host.stop(); return; }
  if (preparing.value || host.phase !== 'offline') return;
  preparing.value = true;
  try {
    const id = await devices.ensureLocalDevice();
    if (!disposed && id) await host.start(id);
  } catch {
    if (!disposed) message.error('本机初始化失败，请重新登录后重试。');
  } finally { preparing.value = false; }
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); message.success('已复制'); }
  catch { message.error('复制失败，请手动复制连接信息。'); }
}
function share() {
  if (!validCredentials.value || !host.credentials) return;
  void copy(`NearLink 远程协助\n设备代码：${host.credentials.deviceCode}\n临时密码：${host.credentials.temporaryPassword}\n连接后需要我在本机确认。`);
}
async function refreshPassword() {
  try { await host.refreshCredentials(); now.value = Date.now(); }
  catch { message.error('刷新失败，请稍后重试；需要立即失效时请关闭协助。'); }
}
async function openPermission(permission: 'screenCapture' | 'inputControl') {
  try { await invoke('remote_control_open_permission_settings', { permission }); }
  catch { message.error('请在系统设置 → 隐私与安全性中开启对应权限。'); }
}
async function connect() {
  if (!canConnect.value) return;
  connecting.value = true;
  connectionError.value = '';
  const credentials = { deviceCode: normalizedCode.value, temporaryPassword: temporaryPassword.value };
  temporaryPassword.value = '';
  try { await session.start(credentials, requestedScope.value); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    connectionError.value = code === 'REMOTE_CODE_RATE_LIMITED' ? '尝试过于频繁，请一分钟后重试。' :
      code === 'REMOTE_CODE_INVALID' ? '设备代码或临时密码无效，请向对方确认最新信息。' :
      '连接未成功，请确认对方已开启协助、当前在线且没有其他会话。';
  } finally { connecting.value = false; }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
  await remote.refreshCapabilities();
  if (!disposed && remote.capabilities?.canHostView) await toggleHost(true);
});
onUnmounted(() => { disposed = true; if (preparing.value) devices.cancel(); clearInterval(timer); temporaryPassword.value = ''; });
</script>

<style scoped>
.remote-workbench { box-sizing: border-box; padding: clamp(24px, 5vw, 72px); color: #202936; background: #fff; min-width: 0; overflow: auto; height: 100%; }
.workbench-heading { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 24px 0; }
/* 只旋转原图标，避免按钮内置 loading 与原图标在切换动画中同时显示。 */
.refresh-capabilities { flex: none; height: 32px; }
.refresh-capabilities .iconfont { display: inline-block; width: 18px; height: 18px; line-height: 18px; font-size: 18px; }
.refresh-capabilities .is-refreshing { animation: refresh-capabilities-spin 1s linear infinite; }
@keyframes refresh-capabilities-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .refresh-capabilities .is-refreshing { animation: none; } }
h2 { font-size: 24px; font-weight: 700; margin: 0; }
.credentials-card { display: grid; grid-template-columns: 1fr 1fr; background: #f5f6f8; border-radius: 20px; padding: 28px; gap: 28px; }
.credential-field { min-width: 0; }
.password-field { border-left: 1px solid #e6e8ed; padding-left: 28px; }
.field-label { font-size: 18px; color: #687484; }
.credential-value { display: flex; align-items: center; gap: 14px; min-height: 64px; flex-wrap: wrap; }
.credential-value strong { font-size: clamp(24px, 2.5vw, 38px); font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.credential-value button { color: #66717f; background: none; border: 0; cursor: pointer; padding: 6px; }
.credential-value button:disabled { opacity: .4; cursor: default; }
.credential-value button:focus-visible { outline: 2px solid #2563eb; border-radius: 4px; }
.iconfont { font-size: 23px; }
.credential-actions, .session-strip { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
.credential-actions, .hint { color: #8691a0; font-size: 13px; }
.connection-form { margin-top: 72px; }
.connection-fields { display: grid; grid-template-columns: 1.4fr 1fr auto; gap: 16px; margin: 24px 0 18px; }
.connection-fields :deep(.n-input), .connection-fields :deep(.n-button) { min-height: 48px; border-radius: 12px; align-items: center; }
.connection-fields :deep(.n-button) { min-width: 112px; }
.error { color: #c53838; margin-top: 12px; }
.permission-actions { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px; }
@media (max-width: 1000px) { .credentials-card { grid-template-columns: 1fr; } .password-field { border-left: 0; padding-left: 0; border-top: 1px solid #e6e8ed; padding-top: 20px; } .connection-fields { grid-template-columns: 1fr; } .connection-form { margin-top: 40px; } }
</style>
