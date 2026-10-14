import happyBeep from '@/assets/sounds/happy-beep.mp3';
import classicRing from '@/assets/sounds/classic-ring.mp3';

export const messageTones = [
  { label: '轻提示（默认）', value: 'default', src: '' },
  { label: '清脆提示', value: 'happy', src: happyBeep },
] as const;
export const callTones = [
  { label: '轻快旋律（默认）', value: 'default', src: '' },
  { label: '经典电话', value: 'classic', src: classicRing },
] as const;

export type SoundKind = 'message' | 'call';
export interface SoundPreferences {
  messageEnabled: boolean;
  callEnabled: boolean;
  messageTone: (typeof messageTones)[number]['value'];
  callTone: (typeof callTones)[number]['value'];
}

export function readSoundPreferences(): SoundPreferences {
  const enabled = localStorage.getItem('notification_sound_enabled') !== 'false';
  const settings: SoundPreferences = {
    messageEnabled: enabled,
    callEnabled: enabled,
    messageTone: 'default',
    callTone: 'default',
  };
  try {
    const saved = JSON.parse(localStorage.getItem('notification_sounds') || '{}');
    if (!saved || typeof saved !== 'object') return settings;
    if (typeof saved.messageEnabled === 'boolean') settings.messageEnabled = saved.messageEnabled;
    if (typeof saved.callEnabled === 'boolean') settings.callEnabled = saved.callEnabled;
    if (messageTones.some((tone) => tone.value === saved.messageTone))
      settings.messageTone = saved.messageTone;
    if (callTones.some((tone) => tone.value === saved.callTone)) settings.callTone = saved.callTone;
  } catch {
    /* 本地设置损坏时保留旧版静音偏好及默认铃声。 */
  }
  return settings;
}
