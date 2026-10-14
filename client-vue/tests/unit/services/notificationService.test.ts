import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: { title: string; options: NotificationOptions }[] = [];
const sounds: { src: string; loop: boolean; currentTime: number; pause: () => void }[] = [];
const play = vi.fn().mockResolvedValue(undefined);
const pause = vi.fn();
const askPermission = vi.fn();

class BrowserNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = askPermission;
  onclick: ((event: Event) => void) | null = null;
  constructor(title: string, options: NotificationOptions) {
    created.push({ title, options });
  }
  close() {}
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  created.length = 0;
  sounds.length = 0;
  BrowserNotification.permission = 'granted';
  vi.stubGlobal('Notification', BrowserNotification);
  vi.stubGlobal(
    'Audio',
    class {
      src = '';
      volume = 0;
      currentTime = 0;
      loop = false;
      play = play;
      pause = pause;
      constructor() {
        sounds.push(this);
      }
    },
  );
});

describe('通知设置', () => {
  it('主叫使用被叫选择的铃声循环播放，停止后归零且不改动自己的铃声', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    service.startOutgoingRingtone('classic');
    expect(sounds[2]!.src).toContain('classic-ring.mp3');
    expect(sounds[2]!.loop).toBe(true);
    expect(service.getSoundPreferences().callTone).toBe('default');
    sounds[2]!.currentTime = 8;
    service.stopOutgoingRingtone();
    expect(sounds[2]!.currentTime).toBe(0);
    expect(pause).toHaveBeenCalledOnce();
    service.updateSoundPreferences({ callEnabled: false });
    service.startOutgoingRingtone('classic');
    expect(play).toHaveBeenCalledOnce();
  });
  it('消息静音不影响来电，来电静音不影响消息', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    service.updateSoundPreferences({ messageEnabled: false });
    service.playAlert('private');
    expect(play).not.toHaveBeenCalled();
    service.startCallRingtone('private:one');
    expect(play).toHaveBeenCalledOnce();
    service.updateSoundPreferences({ messageEnabled: true, callEnabled: false });
    service.startCallRingtone('private:two');
    expect(play).toHaveBeenCalledOnce();
    service.playAlert('group');
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('迁移旧版静音并恢复独立开关与音效选择', async () => {
    localStorage.setItem('notification_sound_enabled', 'false');
    const { default: service } = await import('../../../src/services/notificationService');
    expect(service.getSoundPreferences()).toMatchObject({
      messageEnabled: false,
      callEnabled: false,
    });
    service.updateSoundPreferences({
      messageEnabled: true,
      messageTone: 'happy',
      callTone: 'classic',
    });
    expect(sounds[0]!.src).toContain('happy-beep.mp3');
    expect(sounds[1]!.src).toContain('classic-ring.mp3');
    vi.resetModules();
    const { default: restored } = await import('../../../src/services/notificationService');
    expect(restored.getSoundPreferences()).toEqual(service.getSoundPreferences());
    expect(restored.getSoundSource('message')).toContain('happy-beep.mp3');
    expect(restored.getSoundSource('call')).toContain('classic-ring.mp3');
  });

  it('无效存储中的铃声使用默认值，不破坏已保存的静音设置', async () => {
    localStorage.setItem(
      'notification_sounds',
      JSON.stringify({ messageEnabled: false, callTone: 'unknown', messageTone: null }),
    );
    const { default: service } = await import('../../../src/services/notificationService');
    expect(service.getSoundPreferences()).toEqual({
      messageEnabled: false,
      callEnabled: true,
      messageTone: 'default',
      callTone: 'default',
    });
  });

  it('响铃期间切换铃声保留邀请状态，结束邀请仍会停止', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    service.startCallRingtone('private:one');
    service.updateSoundPreferences({ callTone: 'classic' });
    expect(sounds[1]!.src).toContain('classic-ring.mp3');
    expect(play).toHaveBeenCalledTimes(2);
    service.stopCallRingtone('private:one');
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it('来电旋律循环播放，同期邀请共用音频，全部结束或静音后停止', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    expect(atob(sounds[1]!.src.split(',')[1]!).slice(0, 4)).toBe('RIFF');
    expect(sounds[1]!.loop).toBe(true);
    service.startCallRingtone('private:alice');
    service.startCallRingtone('group:7:video');
    expect(play).toHaveBeenCalledOnce();
    service.stopCallRingtone('private:alice');
    expect(pause).not.toHaveBeenCalled();
    service.stopCallRingtone('group:7:video');
    expect(pause).toHaveBeenCalledOnce();
    service.startCallRingtone('private:bob');
    expect(play).toHaveBeenCalledTimes(2);
    service.updateSoundPreferences({ messageEnabled: false, callEnabled: false });
    expect(pause).toHaveBeenCalledTimes(3);
    service.startCallRingtone('private:carol');
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('通知类型、消息预览和声音设置控制实际发送结果', async () => {
    const { default: service } = await import('../../../src/services/notificationService');
    expect(atob(sounds[0]!.src.split(',')[1]!).slice(0, 4)).toBe('RIFF');
    service.updatePreferences({ notifyPrivateMessage: false, messagePreview: false });
    expect(await service.showMessage('小明', '秘密内容')).toBe(false);
    expect(created).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();

    service.updatePreferences({ notifyPrivateMessage: true, notifyGroupMessage: false });
    expect(await service.showMessage('小明', '秘密内容')).toBe(true);
    expect(created[0]?.options.body).toBe('收到一条私聊消息');
    expect(play).toHaveBeenCalledOnce();
    expect(await service.showGroupMessage('测试群', '小红', '群内秘密')).toBe(false);
    expect(created).toHaveLength(1);

    service.updateSoundPreferences({ messageEnabled: false, callEnabled: false });
    service.updatePreferences({ notifyGroupMessage: true });
    expect(await service.showGroupMessage('测试群', '小红', '群内秘密')).toBe(true);
    expect(created[1]?.options.body).toBe('收到一条群组消息');
    expect(play).toHaveBeenCalledOnce();

    service.updatePreferences({ notifyCall: false, notifyInvitation: false });
    expect(await service.showCall('小明', 'video')).toBe(false);
    expect(await service.showInvitation('测试群', '小红')).toBe(false);
    service.playAlert('call');
    service.playAlert('invitation');
    expect(created).toHaveLength(2);
    expect(play).toHaveBeenCalledOnce();
  });

  it('未授权时不自动请求权限，测试通知只在真正创建后返回成功', async () => {
    BrowserNotification.permission = 'default';
    askPermission.mockImplementation(async () => {
      BrowserNotification.permission = 'granted';
      return 'granted';
    });
    const { default: service } = await import('../../../src/services/notificationService');
    expect(await service.showSystem('测试通知', '检查通知')).toBe(false);
    expect(askPermission).not.toHaveBeenCalled();
    expect(await service.requestPermission()).toBe(true);
    expect(await service.showSystem('测试通知', '检查通知')).toBe(true);
    expect(created[0]).toMatchObject({ title: '测试通知', options: { body: '检查通知' } });

    service.disable();
    expect(await service.showSystem('测试通知', '检查通知')).toBe(false);
    expect(created).toHaveLength(1);
  });
});
