import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { getRemoteDeviceChallenge, registerRemoteDevice } from '@/api/remoteControl';
import {
  createRemoteDeviceProof,
  probeRemoteDeviceSupport,
  validDeviceChallenge,
  type RemoteDeviceSupport,
} from '@/services/remoteDeviceNative';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';
import { useAuthStore } from './auth';

export const useRemoteDevicesStore = defineStore('remoteDevices', () => {
  const auth = useAuthStore();
  const support = shallowRef<RemoteDeviceSupport | null>(null);
  const phase = ref<'idle' | 'challenge' | 'native' | 'submitting'>('idle');
  const localDeviceId = ref<string | null>(null);
  const error = ref('');
  const busy = computed(() => phase.value !== 'idle');
  let generation = 0;
  let actionAbort: AbortController | null = null;
  function identity() {
    if (!auth.token || auth.loggingOut || !auth.currentUser)
      throw new Error('REMOTE_AUTH_REQUIRED');
    let claims: { userId?: number; sid?: string };
    try {
      claims = JSON.parse(atob(auth.token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      throw new Error('REMOTE_AUTH_REQUIRED');
    }
    if (
      claims.userId !== auth.currentUser.id ||
      typeof claims.sid !== 'string' ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(claims.sid)
    )
      throw new Error('REMOTE_AUTH_REQUIRED');
    return { userId: auth.currentUser.id, sid: claims.sid, authGeneration: auth.authGeneration };
  }
  function sameIdentity(expected: ReturnType<typeof identity>, current: number) {
    if (
      generation !== current ||
      auth.authGeneration !== expected.authGeneration ||
      auth.loggingOut
    )
      return false;
    try {
      const actual = identity();
      return actual.userId === expected.userId && actual.sid === expected.sid;
    } catch {
      return false;
    }
  }
  function cancel() {
    generation++;
    actionAbort?.abort();
    actionAbort = null;
    phase.value = 'idle';
  }
  function reset() {
    cancel();
    localDeviceId.value = null;
    support.value = null;
    error.value = '';
  }
  registerRemoteControlCleanup(reset);

  function begin() {
    if (busy.value) throw new Error('REMOTE_DEVICE_BUSY');
    const expected = identity();
    const current = ++generation;
    const abort = new AbortController();
    actionAbort = abort;
    error.value = '';
    return { expected, current, abort };
  }
  async function register(alias: string) {
    if (busy.value) return false;
    if (!support.value?.desktop || !support.value.registration) {
      error.value = '当前客户端暂不支持设备登记，请升级桌面客户端。';
      return false;
    }
    const { expected, current, abort } = begin();
    phase.value = 'challenge';
    try {
      const { challenge } = await getRemoteDeviceChallenge(abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      if (!validDeviceChallenge(challenge, expected.userId, expected.sid))
        throw new Error('REMOTE_CHALLENGE_INVALID');
      phase.value = 'native';
      const proof = await createRemoteDeviceProof(challenge, alias, abort.signal);
      // This check is immediately before the POST obtains the current access token.
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      phase.value = 'submitting';
      const { device } = await registerRemoteDevice(proof, abort.signal);
      if (!sameIdentity(expected, current) || abort.signal.aborted) return false;
      localDeviceId.value = device.deviceId;
      return true;
    } catch (failure) {
      if (sameIdentity(expected, current) && !abort.signal.aborted) {
        if (failure instanceof Error && failure.message === 'DEVICE_KEY_UNAVAILABLE') {
          error.value = '当前设备身份已撤销或不可用，无法完成本机初始化。';
        } else
          error.value =
            phase.value === 'submitting'
              ? '未能确认本机初始化结果，请稍后重试。'
              : phase.value === 'challenge'
                ? '本机初始化失败，无法取得服务端凭据，请确认后端与 Redis 正常运行。'
                : '设备登记未完成。请确认系统凭据访问权限后重试。';
      }
      return false;
    } finally {
      if (current === generation) {
        phase.value = 'idle';
        actionAbort = null;
      }
    }
  }
  async function ensureLocalDevice() {
    if (localDeviceId.value) return localDeviceId.value;
    const current = generation;
    const value = await probeRemoteDeviceSupport();
    if (generation !== current) return null;
    support.value = value;
    // Registration is idempotent by native key fingerprint, including first use.
    if (!(await register(value.platform === 'macos' ? 'Mac' : 'Windows 电脑'))) return null;
    return localDeviceId.value;
  }
  return {
    ensureLocalDevice,
    localDeviceId,
    busy,
    error,
    cancel,
    reset,
  };
});
