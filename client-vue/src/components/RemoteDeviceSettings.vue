<template>
  <section class="remote-device-settings" aria-label="远程设备管理">
    <h2>我的远程设备</h2>
    <p>管理绑定到当前账号的设备身份。远程协助是否可用取决于客户端和系统权限。</p>
    <p class="note">设备登记不会开启屏幕观看或键鼠控制，也不代表设备在线。发起远程协助无需先登记本机。</p>
    <RemoteHostSettings v-if="remote.capabilities?.showHostEntry" :devices="devices.devices" />
    <n-spin :show="devices.probing">
      <form v-if="devices.support?.desktop && devices.support.registration" class="registration" @submit.prevent="register">
        <label for="remote-device-alias">当前设备名称</label>
        <n-input id="remote-device-alias" v-model:value="alias" placeholder="例如：办公电脑" :maxlength="80" :disabled="devices.busy" />
        <div class="actions">
          <n-button attr-type="submit" type="primary" :disabled="devices.busy || devices.identityUnavailable || !alias.trim()" :loading="['challenge', 'native', 'submitting'].includes(devices.phase)">登记当前设备</n-button>
          <n-button v-if="devices.busy && devices.phase !== 'revoking'" @click="devices.cancel">{{ devices.phase === 'resetting' ? '取消等待' : '取消登记' }}</n-button>
        </div>
      </form>
      <p v-else-if="devices.support?.desktop">当前客户端暂不支持设备登记，请升级桌面客户端后重试。</p>
      <p v-else-if="devices.support">请使用支持设备登记的桌面客户端登记电脑。你仍可在此管理已有设备。</p>
    </n-spin>
    <div v-if="devices.identityUnavailable && devices.support?.desktop">
      <p>重建身份需要本机系统确认。原设备记录仍保持原有状态，协助许可不会继承。</p>
      <n-button v-if="devices.support.identityReset" :disabled="devices.busy" @click="devices.rebuildIdentity">重建设备身份</n-button>
      <p v-else>当前版本不支持重建设备身份，请升级桌面客户端。</p>
    </div>
    <p v-if="devices.error" role="alert">{{ devices.error }}</p>
    <p v-if="devices.notice" role="status">{{ devices.notice }}</p>
    <div class="actions"><n-button :loading="devices.loading" :disabled="devices.busy" @click="devices.refresh">刷新设备列表</n-button></div>
    <p v-if="!devices.loading && !devices.devices.length">当前账号尚无已登记设备。</p>
    <ul v-else>
      <li v-for="device in devices.devices" :key="device.deviceId">
        <div><strong>{{ device.alias }}</strong><span> · {{ device.platform === 'macos' ? 'macOS' : 'Windows' }} · {{ device.revokedAt ? '已撤销' : '已登记' }}</span></div>
        <n-popconfirm v-if="!device.revokedAt" positive-text="确认" negative-text="取消" @positive-click="devices.revoke(device.deviceId)">
          <template #trigger><n-button size="small" :disabled="devices.busy">撤销登记</n-button></template>
          撤销“{{ device.alias }}”的设备登记和协助许可？撤销后需重新登记新的设备身份。
        </n-popconfirm>
      </li>
    </ul>
  </section>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { NButton, NInput, NPopconfirm, NSpin } from 'naive-ui';
import { useRemoteDevicesStore } from '@/stores/remoteDevices';
import { useRemoteControlStore } from '@/stores/remoteControl';
import RemoteHostSettings from './RemoteHostSettings.vue';
const remote = useRemoteControlStore();
const devices = useRemoteDevicesStore();
const alias = ref('');
async function register() { await devices.register(alias.value); }
onMounted(() => { void devices.initialize(); });
onUnmounted(() => devices.cancel());
</script>
<style scoped>
h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
p { line-height: 1.7; margin: 12px 0; }
.note { color: #64748b; font-size: 13px; }
.registration { max-width: 420px; display: grid; gap: 10px; margin: 20px 0; }
.actions { display: flex; gap: 10px; margin: 12px 0; }
ul { display: grid; gap: 12px; padding: 0; list-style: none; }
li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; }
span { color: #64748b; }
[role=alert] { color: #b91c1c; }
</style>
