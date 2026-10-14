import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  defaultNotificationSettings,
  getNotificationSettings,
  updateNotificationSettings,
  type NotificationSettings,
} from '@/api/notificationSettings';
import notificationService from '@/services/notificationService';

export const useNotificationSettingsStore = defineStore('notificationSettings', () => {
  const settings = ref({ ...defaultNotificationSettings });
  const status = ref<'idle' | 'loading' | 'ready' | 'saving' | 'error'>('idle');
  const error = ref('');
  const disabled = computed(() => status.value !== 'ready');
  let accountId: number | null = null;
  let session = 0;
  let loading: Promise<void> | null = null;

  function apply(value: NotificationSettings) {
    settings.value = { ...value };
    const { desktopEnabled, messageEnabled, callEnabled, messageTone, callTone, ...preferences } =
      value;
    notificationService.updatePreferences(preferences);
    notificationService.updateSoundPreferences({
      messageEnabled,
      callEnabled,
      messageTone,
      callTone,
    });
    if (desktopEnabled) notificationService.enable();
    else notificationService.disable();
  }

  function reset() {
    session++;
    accountId = null;
    loading = null;
    status.value = 'idle';
    error.value = '';
    apply(defaultNotificationSettings);
  }

  async function load(userId: number) {
    if (accountId === userId && loading) return loading;
    if (accountId === userId && status.value === 'saving') return;
    if (accountId !== userId) reset();
    accountId = userId;
    status.value = 'loading';
    error.value = '';
    const currentSession = session;
    const request = (async () => {
      try {
        const { settings: saved } = await getNotificationSettings();
        if (session !== currentSession) return;
        apply(saved);
        status.value = 'ready';
      } catch {
        if (session !== currentSession) return;
        status.value = 'error';
        error.value = '通知设置加载失败，请重试';
      } finally {
        if (session === currentSession) loading = null;
      }
    })();
    loading = request;
    return request;
  }

  async function save(value: Partial<NotificationSettings>) {
    if (disabled.value) return;
    const currentSession = session;
    status.value = 'saving';
    error.value = '';
    try {
      const { settings: saved } = await updateNotificationSettings(value);
      if (session === currentSession) apply(saved);
    } catch {
      if (session === currentSession) error.value = '通知设置保存失败，已保留原设置，请重试';
    } finally {
      if (session === currentSession) status.value = 'ready';
    }
  }

  return { settings, status, error, disabled, load, save, reset };
});
