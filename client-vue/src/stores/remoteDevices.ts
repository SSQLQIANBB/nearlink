import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { getRemoteDeviceChallenge, getRemoteDevices, registerRemoteDevice, revokeRemoteDevice, renameRemoteDevice, type RemoteDevice } from '@/api/remoteControl';
import { createRemoteDeviceProof, probeRemoteDeviceSupport, resetRemoteDeviceIdentity, validDeviceChallenge, type RemoteDeviceSupport } from '@/services/remoteDeviceNative';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';
import { useAuthStore } from './auth';

export const useRemoteDevicesStore = defineStore('remoteDevices', () => {
  const auth = useAuthStore();
  const devices = ref<RemoteDevice[]>([]);
  const support = shallowRef<RemoteDeviceSupport | null>(null);
  const loading = ref(false);
  const probing = ref(false);
  const phase = ref<'idle' | 'challenge' | 'native' | 'submitting' | 'revoking' | 'resetting' | 'renaming'>('idle');
  const identityUnavailable = ref(false);
  const error = ref('');
  const notice = ref('');
  const busy = computed(() => phase.value !== 'idle');
  let generation = 0;
  let listSequence = 0;
  let listAbort: AbortController | null = null;
  let actionAbort: AbortController | null = null;
  let supportSequence = 0;
  function identity() {
    if (!auth.token || auth.loggingOut || !auth.currentUser) throw new Error('REMOTE_AUTH_REQUIRED');
    let claims: { userId?: number; sid?: string };
    try { claims = JSON.parse(atob(auth.token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))); }
    catch { throw new Error('REMOTE_AUTH_REQUIRED'); }
    if (claims.userId !== auth.currentUser.id || typeof claims.sid !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(claims.sid)) throw new Error('REMOTE_AUTH_REQUIRED');
    return { userId: auth.currentUser.id, sid: claims.sid, authGeneration: auth.authGeneration };
  }
  function sameIdentity(expected: ReturnType<typeof identity>, current: number) {
    if (generation !== current || auth.authGeneration !== expected.authGeneration || auth.loggingOut) return false;
    try { const actual = identity(); return actual.userId === expected.userId && actual.sid === expected.sid; } catch { return false; }
  }
  function cancel() {
    generation++;
    actionAbort?.abort(); actionAbort = null;
    notice.value = phase.value === 'submitting' ? '登记请求可能已提交，请刷新设备列表确认。'
      : phase.value === 'revoking' ? '撤销请求可能已提交，请刷新设备列表确认。'
      : phase.value === 'renaming' ? '名称可能已保存，请刷新设备列表确认。'
      : phase.value === 'resetting' ? '已停止等待身份重建结果，请重新检测后确认。' : busy.value ? '已取消设备登记。' : notice.value;
    phase.value = 'idle';
  }
  function reset() {
    cancel(); listSequence++; supportSequence++;
    listAbort?.abort(); listAbort = null;
    devices.value = []; support.value = null; loading.value = false; probing.value = false;
    error.value = ''; notice.value = ''; identityUnavailable.value = false;
  }
  registerRemoteControlCleanup(reset);

  async function refresh() {
    let expected: ReturnType<typeof identity>;
    try { expected = identity(); } catch { reset(); return; }
    const current = generation;
    const sequence = ++listSequence;
    listAbort?.abort();
    const abort = new AbortController(); listAbort = abort;
    loading.value = true; error.value = '';
    try {
      const result = await getRemoteDevices(abort.signal);
      if (sameIdentity(expected, current) && sequence === listSequence) devices.value = result.devices;
    } catch {
      if (!abort.signal.aborted && sameIdentity(expected, current) && sequence === listSequence) error.value = '无法读取设备列表，请稍后刷新。';
    } finally { if (sequence === listSequence) { loading.value = false; listAbort = null; } }
  }
  async function initialize() {
    const sequence = ++supportSequence;
    probing.value = true;
    const load = refresh();
    const value = await probeRemoteDeviceSupport();
    if (sequence === supportSequence) { support.value = value; probing.value = false; }
    await load;
  }
  function begin() {
    if (busy.value) throw new Error('REMOTE_DEVICE_BUSY');
    const expected = identity();
    const current = ++generation;
    const abort = new AbortController(); actionAbort = abort;
    error.value = ''; notice.value = '';
    return { expected, current, abort };
  }
  async function register(alias: string) {
    if (busy.value || identityUnavailable.value) return false;
    if (!support.value?.desktop || !support.value.registration) { error.value = '当前客户端暂不支持设备登记，请升级桌面客户端。'; return false; }
    alias = alias.trim();
    if (!alias || alias.length > 80 || /[\u0000-\u001f\u007f]/.test(alias)) { error.value = '请输入 1–80 个字符的设备名称。'; return false; }
    const { expected, current, abort } = begin();
    phase.value = 'challenge';
    try {
      const { challenge } = await getRemoteDeviceChallenge(abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      if (!validDeviceChallenge(challenge, expected.userId, expected.sid)) throw new Error('REMOTE_CHALLENGE_INVALID');
      phase.value = 'native';
      const proof = await createRemoteDeviceProof(challenge, alias, abort.signal);
      // This check is immediately before the POST obtains the current access token.
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      phase.value = 'submitting';
      const { device } = await registerRemoteDevice(proof, abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      listSequence++; listAbort?.abort(); listAbort = null; loading.value = false;
      devices.value = [device, ...devices.value.filter(item => item.deviceId !== device.deviceId)];
      notice.value = '设备身份已登记。登记不会开启远程观看或键鼠控制。';
      return true;
    } catch (failure) {
      if (sameIdentity(expected, current) && !abort.signal.aborted) {
        if (failure instanceof Error && failure.message === 'DEVICE_KEY_UNAVAILABLE') {
          identityUnavailable.value = true;
          error.value = '当前设备身份已撤销或不可用，需要在本机重建设备身份后才能再次登记。';
        } else error.value = phase.value === 'submitting'
          ? '未能确认登记结果，请先刷新设备列表，再决定是否重试。'
          : phase.value === 'challenge' ? '未能取得登记凭据，请稍后重试。'
          : '设备登记未完成。请确认系统凭据访问权限后重试。';
      }
      return false;
    } finally { if (current === generation) { phase.value = 'idle'; actionAbort = null; } }
  }
  async function revoke(deviceId: string) {
    if (busy.value) return false;
    if (!devices.value.some(device => device.deviceId === deviceId && !device.revokedAt)) return false;
    const { expected, current, abort } = begin();
    phase.value = 'revoking';
    try {
      await revokeRemoteDevice(deviceId, abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      // Invalidate a list captured before this deletion, then read authoritative revocation time.
      listSequence++; listAbort?.abort();
      devices.value = devices.value.filter(device => device.deviceId !== deviceId);
      notice.value = '已撤销设备登记及该设备的协助许可。';
      await refresh();
      return true;
    } catch {
      if (sameIdentity(expected, current) && !abort.signal.aborted) error.value = '未能确认撤销结果，请刷新设备列表确认。';
      return false;
    } finally { if (current === generation) { phase.value = 'idle'; actionAbort = null; } }
  }
  async function rename(deviceId: string, alias: string) {
    if (busy.value || !devices.value.some(device => device.deviceId === deviceId && !device.revokedAt)) return false;
    alias = alias.trim();
    if (!alias || alias.length > 80 || /[\u0000-\u001f\u007f]/.test(alias)) { error.value = '请输入 1–80 个字符的设备名称。'; return false; }
    const { expected, current, abort } = begin();
    phase.value = 'renaming';
    try {
      const { device } = await renameRemoteDevice(deviceId, alias, abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      listSequence++; listAbort?.abort(); listAbort = null; loading.value = false;
      devices.value = devices.value.map(item => item.deviceId === deviceId ? device : item);
      notice.value = '设备名称已保存。其他客户端刷新设备列表后可见。';
      return true;
    } catch {
      if (sameIdentity(expected, current) && !abort.signal.aborted) error.value = '未能确认名称修改结果，请刷新设备列表确认。';
      return false;
    } finally { if (current === generation) { phase.value = 'idle'; actionAbort = null; } }
  }
  async function rebuildIdentity() {
    if (busy.value || !identityUnavailable.value || !support.value?.desktop || !support.value.identityReset) return false;
    const { expected, current, abort } = begin();
    phase.value = 'resetting';
    try {
      const rebuilt = await resetRemoteDeviceIdentity(expected.userId, abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      if (rebuilt) identityUnavailable.value = false;
      notice.value = rebuilt ? '本机设备身份已重建，请重新登记。原设备记录和协助许可不会继承。' : '已取消重建，原设备身份未更改。';
      return rebuilt;
    } catch {
      if (sameIdentity(expected, current) && !abort.signal.aborted) error.value = '未能确认身份重建结果，请检查系统确认窗口后重试。';
      return false;
    } finally { if (current === generation) { phase.value = 'idle'; actionAbort = null; } }
  }
  return { devices, support, loading, probing, phase, busy, identityUnavailable, error, notice, initialize, refresh, register, revoke, rename, rebuildIdentity, cancel, reset };
});
