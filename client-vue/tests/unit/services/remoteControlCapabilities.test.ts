import { describe, expect, it } from 'vitest';
import {
  deriveRemoteCapabilities,
  type NativeRemoteCapabilities,
  type ControllerFeatures,
} from '@/services/remoteControlCapabilities';
import type { RemoteControlRelease } from '@/api/remoteControl';

const release: RemoteControlRelease = {
  protocolVersion: 1,
  desktopControllerEnabled: true,
  desktopHostEnabled: true,
  webControllerReleaseEnabled: false,
  releasedPlatforms: ['macos', 'windows'],
  engineRequired: true,
};
const native: NativeRemoteCapabilities = {
  runtime: 'tauri',
  platform: 'macos',
  osVersion: '13',
  arch: 'aarch64',
  protocolVersion: 1,
  engineReady: false,
  canCapture: false,
  canInjectInput: false,
  permissions: { screenCapture: 'denied', inputControl: 'denied' },
};
const features: ControllerFeatures = {
  secureContext: true,
  canDecodeVideo: true,
  canUseDataChannel: true,
  canSendInput: true,
  canVerifySignatures: true,
  supportedDesktopBrowser: true,
};

describe('远控能力与发布门禁', () => {
  it('浏览器即使声称有桌面报告也不会获得桌面入口或被控能力', () => {
    const result = deriveRemoteCapabilities('web', release, native, features);
    expect(result.showControllerEntry).toBe(false);
    expect(result.canControl).toBe(false);
    expect(result.canHostView).toBe(false);
  });
  it('主控不要求本机引擎和被控权限', () => {
    const result = deriveRemoteCapabilities('tauri', release, native, features);
    expect(result.showControllerEntry).toBe(true);
    expect(result.canControl).toBe(true);
    expect(result.canHostControl).toBe(false);
    expect(result.showHostEntry).toBe(false);
  });
  it('配置未知、平台未发布和协议不兼容均失败关闭', () => {
    for (const result of [
      deriveRemoteCapabilities('tauri', null, native, features),
      deriveRemoteCapabilities('tauri', release, null, features),
      deriveRemoteCapabilities('tauri', { ...release, releasedPlatforms: [] }, native, features),
      deriveRemoteCapabilities('tauri', release, { ...native, protocolVersion: 2 }, features),
      deriveRemoteCapabilities(
        'web',
        { ...release, protocolVersion: 2, webControllerReleaseEnabled: true },
        null,
        features,
      ),
    ])
      expect(result.canControl).toBe(false);
  });
  it('发布后的浏览器仍需安全环境和实际WebRTC能力', () => {
    const webRelease = { ...release, webControllerReleaseEnabled: true };
    expect(deriveRemoteCapabilities('web', webRelease, null, features).canControl).toBe(true);
    for (const key of Object.keys(features) as (keyof ControllerFeatures)[]) {
      expect(
        deriveRemoteCapabilities('web', webRelease, null, { ...features, [key]: false }).canControl,
      ).toBe(false);
    }
  });
  it('原生能力发布后保留权限设置入口，但拒绝缺少权限的实际采集', () => {
    const result = deriveRemoteCapabilities(
      'tauri',
      release,
      { ...native, engineReady: true },
      features,
    );
    expect(result.showHostEntry).toBe(true);
    expect(result.canHostView).toBe(false);
    expect(result.canHostControl).toBe(false);
  });
  it('权限已授予仍必须具备原生采集能力和引擎', () => {
    const authorized = {
      ...native,
      permissions: { screenCapture: 'granted', inputControl: 'granted' } as const,
    };
    expect(deriveRemoteCapabilities('tauri', release, authorized, features).canHostControl).toBe(
      false,
    );
    const ready = { ...authorized, engineReady: true, canCapture: true, canInjectInput: true };
    expect(deriveRemoteCapabilities('tauri', release, ready, features).canHostControl).toBe(true);
    expect(
      deriveRemoteCapabilities('tauri', { ...release, desktopHostEnabled: false }, ready, features)
        .canHostControl,
    ).toBe(false);
  });
});
