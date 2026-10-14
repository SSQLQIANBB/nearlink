import {
  callTones,
  messageTones,
  readSoundPreferences,
  type SoundKind,
  type SoundPreferences,
} from './notificationSounds';
import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * 通知服务 - 管理桌面通知、声音提醒等
 */

export type NotificationType = 'private' | 'group' | 'call' | 'invitation' | 'system';
export type NotificationPreferences = {
  messagePreview: boolean;
  notifyPrivateMessage: boolean;
  notifyGroupMessage: boolean;
  notifyCall: boolean;
  notifyInvitation: boolean;
};

const defaultPreferences: NotificationPreferences = {
  messagePreview: true,
  notifyPrivateMessage: true,
  notifyGroupMessage: true,
  notifyCall: true,
  notifyInvitation: true,
};

export interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  type?: NotificationType;
  onClick?: () => void;
  silent?: boolean; // 是否静音
}

class NotificationService {
  private permission: NotificationPermission = 'default';
  private enabled: boolean = true;
  private soundPreferences = readSoundPreferences();
  private defaultSoundSources = { message: '', call: '' };
  private notificationSound: HTMLAudioElement | null = null;
  private callRingtone: HTMLAudioElement | null = null;
  private outgoingRingtone: HTMLAudioElement | null = null;
  private activeCallRingtones = new Set<string>();
  private preferences: NotificationPreferences = { ...defaultPreferences };

  constructor() {
    this.init();
  }

  /**
   * 初始化通知服务
   */
  async init() {
    // 检查浏览器是否支持通知
    this.permission = 'Notification' in window ? Notification.permission : 'denied';

    // 从 localStorage 读取用户设置
    const savedEnabled = localStorage.getItem('notification_enabled');
    if (savedEnabled !== null) this.enabled = savedEnabled === 'true';

    try {
      const saved = JSON.parse(localStorage.getItem('notify_settings') || '{}');
      for (const key of Object.keys(defaultPreferences) as (keyof NotificationPreferences)[]) {
        if (typeof saved[key] === 'boolean') this.preferences[key] = saved[key];
      }
    } catch (error) {
      console.warn('通知设置格式无效，使用默认值:', error);
    }

    // 初始化音频
    this.initAudio();
    this.initCallRingtone();
    this.defaultSoundSources = {
      message: this.notificationSound?.src || '',
      call: this.callRingtone?.src || '',
    };
    this.applySoundSources();
  }

  /** 在浏览器内生成原创的短旋律，循环播放时无需额外下载音频文件。 */
  private initCallRingtone() {
    try {
      const sampleRate = 8000;
      const sampleCount = sampleRate * 4;
      const bytes = new Uint8Array(44 + sampleCount * 2);
      const view = new DataView(bytes.buffer);
      const label = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index++)
          bytes[offset + index] = value.charCodeAt(index);
      };
      label(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      label(8, 'WAVE');
      label(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      label(36, 'data');
      view.setUint32(40, sampleCount * 2, true);
      const notes = [392, 587, 494, 659, 440, 659, 523, 784];
      const noteLength = 0.43;
      for (let index = 0; index < sampleCount; index++) {
        const seconds = index / sampleRate;
        const noteIndex = Math.floor(seconds / noteLength);
        const frequency = notes[noteIndex];
        if (!frequency) continue;
        const elapsed = seconds - noteIndex * noteLength;
        const envelope =
          Math.min(1, elapsed * 30, (noteLength - elapsed) * 25) * Math.exp(-elapsed * 2);
        const tone =
          Math.sin(2 * Math.PI * frequency * elapsed) +
          0.18 * Math.sin(4 * Math.PI * frequency * elapsed);
        view.setInt16(44 + index * 2, Math.round(tone * envelope * 10500), true);
      }
      this.callRingtone = new Audio();
      this.callRingtone.src = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
      this.callRingtone.volume = 0.55;
      this.callRingtone.loop = true;
    } catch (error) {
      console.warn('来电音初始化失败:', error);
    }
  }

  /** 创建可播放的短提示音；原来的固定 data URL 并不是完整的 WAV 文件。 */
  private initAudio() {
    try {
      this.notificationSound = new Audio();
      const sampleRate = 8000;
      const sampleCount = 1600;
      const bytes = new Uint8Array(44 + sampleCount * 2);
      const view = new DataView(bytes.buffer);
      const label = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index++)
          bytes[offset + index] = value.charCodeAt(index);
      };
      label(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      label(8, 'WAVE');
      label(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      label(36, 'data');
      view.setUint32(40, sampleCount * 2, true);
      for (let index = 0; index < sampleCount; index++) {
        const seconds = index / sampleRate;
        const amplitude = Math.sin(2 * Math.PI * 800 * seconds) * Math.exp(-seconds * 18);
        view.setInt16(44 + index * 2, Math.round(amplitude * 11000), true);
      }
      this.notificationSound.src = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
      this.notificationSound.volume = 0.5;
    } catch (error) {
      console.warn('音频初始化失败:', error);
    }
  }

  /**
   * 请求通知权限
   */
  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
      return false;
    }

    this.permission = Notification.permission;
    if (this.permission === 'granted') {
      return true;
    }

    try {
      this.permission = await Notification.requestPermission();
      return this.permission === 'granted';
    } catch (error) {
      console.error('请求通知权限失败:', error);
      return false;
    }
  }

  /**
   * 显示通知
   */
  async show(options: NotificationOptions): Promise<boolean> {
    if (!this.shouldNotify(options.type || 'system')) return false;
    this.playAlert(options.type || 'system', options.silent);
    if (!this.enabled) return false;

    // 创建通知
    try {
      if (isTauri()) {
        const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
        if (!(await isPermissionGranted())) return false;
        // 桌面插件不实现 Web Notification 的 close/onclick，通知生命周期由 Windows 管理。
        await invoke('plugin:notification|notify', {
          options: { title: options.title, body: options.body },
        });
        return true;
      }
      if (this.getPermission() !== 'granted') return false;
      const notification = new Notification(options.title, {
        body: options.body,
        icon: options.icon || '/app-icon.png',
        tag: options.tag,
        requireInteraction: false, // 自动关闭
        silent: true, // 统一使用可由声音开关控制的应用提示音
      });

      // 点击通知时的回调
      if (options.onClick) {
        notification.onclick = (event) => {
          event.preventDefault();
          window.focus(); // 聚焦窗口
          options.onClick?.();
          notification.close();
        };
      }

      // 3秒后自动关闭
      setTimeout(() => {
        notification.close();
      }, 5000);
      return true;
    } catch (error) {
      console.error('显示通知失败:', error);
      return false;
    }
  }

  getPreferences(): NotificationPreferences {
    return { ...this.preferences };
  }

  updatePreferences(value: Partial<NotificationPreferences>) {
    this.preferences = { ...this.preferences, ...value };
    localStorage.setItem('notify_settings', JSON.stringify(this.preferences));
    if (!this.preferences.notifyCall) this.stopAllCallRingtones();
  }

  shouldNotify(type: NotificationType): boolean {
    const keys: Partial<Record<NotificationType, keyof NotificationPreferences>> = {
      private: 'notifyPrivateMessage',
      group: 'notifyGroupMessage',
      call: 'notifyCall',
      invitation: 'notifyInvitation',
    };
    const key = keys[type];
    return key ? this.preferences[key] : true;
  }

  previewMessage(message: string, type: 'private' | 'group'): string {
    return this.preferences.messagePreview
      ? message
      : type === 'private'
        ? '收到一条私聊消息'
        : '收到一条群组消息';
  }

  playAlert(type: NotificationType, silent = false) {
    if (!silent && this.shouldNotify(type)) this.playSound(type);
  }

  startCallRingtone(key: string) {
    if (!this.soundPreferences.callEnabled || !this.shouldNotify('call') || !this.callRingtone)
      return;
    if (this.activeCallRingtones.has(key)) return;
    const alreadyPlaying = this.activeCallRingtones.size > 0;
    this.activeCallRingtones.add(key);
    if (alreadyPlaying) return;
    this.callRingtone.currentTime = 0;
    void this.callRingtone.play().catch((error) => {
      console.warn('播放来电音失败:', error);
    });
  }

  stopCallRingtone(key: string) {
    this.activeCallRingtones.delete(key);
    if (this.activeCallRingtones.size === 0) {
      this.callRingtone?.pause();
      if (this.callRingtone) this.callRingtone.currentTime = 0;
    }
  }

  startOutgoingRingtone(tone: SoundPreferences['callTone']) {
    if (!this.soundPreferences.callEnabled) return;
    this.stopOutgoingRingtone();
    const audio = (this.outgoingRingtone ||= new Audio());
    audio.src = callTones.find((item) => item.value === tone)!.src || this.defaultSoundSources.call;
    audio.volume = 0.55;
    audio.loop = true;
    void audio.play().catch((error) => console.warn('播放回铃音失败:', error));
  }

  stopOutgoingRingtone() {
    this.outgoingRingtone?.pause();
    if (this.outgoingRingtone) this.outgoingRingtone.currentTime = 0;
  }

  private stopAllCallRingtones() {
    this.activeCallRingtones.clear();
    this.callRingtone?.pause();
    if (this.callRingtone) this.callRingtone.currentTime = 0;
  }

  /**
   * 播放提示音
   */
  private playSound(type?: NotificationType) {
    if (!this.soundPreferences.messageEnabled || !this.notificationSound) {
      return;
    }

    try {
      // 重置音频
      this.notificationSound.currentTime = 0;

      // 根据不同类型调整音量和音调（可选）
      switch (type) {
        case 'call':
          this.notificationSound.volume = 0.7;
          break;
        case 'invitation':
          this.notificationSound.volume = 0.6;
          break;
        case 'system':
          this.notificationSound.volume = 0.4;
          break;
        default:
          this.notificationSound.volume = 0.5;
      }

      // 播放音频
      this.notificationSound.play().catch((error) => {
        console.warn('播放提示音失败:', error);
      });
    } catch (error) {
      console.warn('播放提示音失败:', error);
    }
  }

  /**
   * 显示消息通知
   */
  async showMessage(from: string, message: string, avatar?: string, onClick?: () => void) {
    return this.show({
      title: `新消息 - ${from}`,
      body: this.previewMessage(message, 'private'),
      icon: avatar,
      tag: `message-${from}`,
      type: 'private',
      onClick,
    });
  }

  /**
   * 显示群组消息通知
   */
  async showGroupMessage(
    groupName: string,
    from: string,
    message: string,
    avatar?: string,
    onClick?: () => void,
  ) {
    return this.show({
      title: `${groupName}`,
      body: this.preferences.messagePreview ? `${from}: ${message}` : '收到一条群组消息',
      icon: avatar,
      tag: `group-message-${groupName}`,
      type: 'group',
      onClick,
    });
  }

  /**
   * 显示通话通知
   */
  async showCall(
    from: string,
    type: 'video' | 'audio' | 'screen',
    avatar?: string,
    onClick?: () => void,
  ) {
    const typeText = type === 'video' ? '视频通话' : type === 'audio' ? '语音通话' : '屏幕共享';
    return this.show({
      title: `来电 - ${from}`,
      body: `${from} 邀请您进行${typeText}`,
      icon: avatar,
      tag: `call-${from}`,
      type: 'call',
      onClick,
      silent: true, // 来电旋律由邀请弹窗控制，避免桌面通知再次播放短提示音
    });
  }

  /**
   * 显示群组邀请通知
   */
  async showInvitation(groupName: string, from: string, avatar?: string, onClick?: () => void) {
    return this.show({
      title: '群组邀请',
      body: `${from} 邀请您加入群组 "${groupName}"`,
      icon: avatar,
      tag: `invitation-${groupName}`,
      type: 'invitation',
      onClick,
    });
  }

  /**
   * 显示系统通知
   */
  async showSystem(title: string, message: string, onClick?: () => void) {
    return this.show({
      title,
      body: message,
      type: 'system',
      onClick,
    });
  }

  /**
   * 启用通知
   */
  enable() {
    this.enabled = true;
    localStorage.setItem('notification_enabled', 'true');
  }

  /**
   * 禁用通知
   */
  disable() {
    this.enabled = false;
    localStorage.setItem('notification_enabled', 'false');
  }

  getSoundPreferences(): SoundPreferences {
    return { ...this.soundPreferences };
  }

  getSoundSource(kind: SoundKind): string {
    return kind === 'message'
      ? messageTones.find((tone) => tone.value === this.soundPreferences.messageTone)!.src ||
          this.defaultSoundSources.message
      : callTones.find((tone) => tone.value === this.soundPreferences.callTone)!.src ||
          this.defaultSoundSources.call;
  }

  private applySoundSources() {
    if (this.notificationSound) this.notificationSound.src = this.getSoundSource('message');
    if (this.callRingtone) this.callRingtone.src = this.getSoundSource('call');
  }

  updateSoundPreferences(value: Partial<SoundPreferences>) {
    const previous = this.soundPreferences;
    this.soundPreferences = { ...previous, ...value };
    localStorage.setItem('notification_sounds', JSON.stringify(this.soundPreferences));
    if (previous.messageTone !== this.soundPreferences.messageTone && this.notificationSound) {
      this.notificationSound.pause();
      this.notificationSound.src = this.getSoundSource('message');
    }
    if (!this.soundPreferences.messageEnabled) this.notificationSound?.pause();
    if (!this.soundPreferences.callEnabled) {
      this.stopAllCallRingtones();
      this.stopOutgoingRingtone();
    }
    if (previous.callTone !== this.soundPreferences.callTone && this.callRingtone) {
      this.callRingtone.pause();
      this.callRingtone.src = this.getSoundSource('call');
      if (this.activeCallRingtones.size > 0) {
        void this.callRingtone.play().catch((error) => console.warn('播放来电音失败:', error));
      }
    }
  }

  /**
   * 获取通知是否启用
   */
  isEnabled(): boolean {
    return this.enabled && this.getPermission() === 'granted';
  }

  /**
   * 获取权限状态
   */
  getPermission(): NotificationPermission {
    this.permission = 'Notification' in window ? Notification.permission : 'denied';
    return this.permission;
  }
}

// 导出单例
const notificationService = new NotificationService();
export default notificationService;
