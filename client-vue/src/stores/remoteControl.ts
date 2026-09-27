import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { getRemoteControlRelease, getRemoteSessions, getRemoteTargets, type RemoteSessionRecord, type RemoteTarget } from '@/api/remoteControl';
import { probeRemoteCapabilities, type RemoteCapabilities } from '@/services/remoteControlCapabilities';
import { registerRemoteControlCleanup } from '@/services/remoteControlSafety';

export const useRemoteControlStore = defineStore('remoteControl', () => {
  const capabilities = shallowRef<RemoteCapabilities | null>(null);
  const targets = ref<RemoteTarget[]>([]);
  const sessions = ref<RemoteSessionRecord[]>([]);
  const loading = ref(false);
  const error = ref('');
  let generation = 0;
  let discoveryGeneration = 0;
  let inFlight: Promise<void> | null = null;
  const showControllerEntry = computed(() => capabilities.value?.showControllerEntry === true);
  const canControl = computed(() => !loading.value && capabilities.value?.canControl === true);

  function reset() {
    generation++;
    discoveryGeneration++;
    capabilities.value = null;
    targets.value = [];
    sessions.value = [];
    error.value = '';
    loading.value = false;
    inFlight = null;
  }
  registerRemoteControlCleanup(reset);

  function refreshCapabilities() {
    if (inFlight) return inFlight;
    const current = generation;
    loading.value = true;
    // Keep the setup panel mounted across focus refreshes so its device/contact
    // selection survives. New controller requests stay blocked while loading;
    // host.start independently obtains a fresh authenticated release snapshot.
    const task = (async () => {
      let release = null;
      try { release = await getRemoteControlRelease(); } catch { /* Fail closed on network/auth/config errors. */ }
      const next = await probeRemoteCapabilities(release);
      if (generation !== current) return;
      capabilities.value = next;
      loading.value = false;
    })();
    inFlight = task;
    void task.finally(() => { if (inFlight === task) inFlight = null; });
    return task;
  }

  async function loadTargets(userId: number) {
    const current = generation;
    const discovery = ++discoveryGeneration;
    targets.value = [];
    error.value = '';
    if (!canControl.value || !Number.isSafeInteger(userId) || userId <= 0) return;
    try {
      const result = await getRemoteTargets(userId);
      if (generation === current && discovery === discoveryGeneration && canControl.value) targets.value = result.targets;
    } catch {
      if (generation === current && discovery === discoveryGeneration) error.value = '无法获取已获协助许可的设备，请稍后重试。';
    }
  }

  async function loadSessions() {
    const current = generation;
    if (!canControl.value) return;
    try {
      const result = await getRemoteSessions();
      if (generation === current && canControl.value) sessions.value = result.sessions;
    } catch {
      if (generation === current) error.value = '暂时无法读取远控连接记录。';
    }
  }

  return { capabilities, targets, sessions, loading, error, showControllerEntry, canControl, refreshCapabilities, loadTargets, loadSessions, reset };
});
