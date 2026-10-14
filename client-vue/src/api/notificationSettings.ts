import { http } from '@/utils/request';
import type { NotificationPreferences } from '@/services/notificationService';
import type { SoundPreferences } from '@/services/notificationSounds';

export type NotificationSettings = NotificationPreferences &
  SoundPreferences & { desktopEnabled: boolean };
export const defaultNotificationSettings: NotificationSettings = {
  desktopEnabled: true,
  messagePreview: true,
  notifyPrivateMessage: true,
  notifyGroupMessage: true,
  notifyCall: true,
  notifyInvitation: true,
  messageEnabled: true,
  callEnabled: true,
  messageTone: 'default',
  callTone: 'default',
};

export function getNotificationSettings() {
  return http.get<{ settings: NotificationSettings }>('/api/auth/notification-settings');
}

export function updateNotificationSettings(value: Partial<NotificationSettings>) {
  return http.put<{ settings: NotificationSettings }>('/api/auth/notification-settings', value);
}
