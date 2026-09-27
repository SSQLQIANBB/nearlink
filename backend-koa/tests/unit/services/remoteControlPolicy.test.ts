import { describe, expect, it } from 'vitest';
import { getRemoteControlCapabilities } from '../../../src/services/remoteControlPolicy';

describe('远控账号预览范围', () => {
  it('默认关闭，预览只允许明确列出的账号和 macOS 平台', () => {
    expect(getRemoteControlCapabilities(1, {}).desktopHostEnabled).toBe(false);
    const env = { REMOTE_CONTROL_PREVIEW_USER_IDS: '1,4' };
    expect(getRemoteControlCapabilities(4, env)).toMatchObject({ desktopHostEnabled: true, webControllerReleaseEnabled: true, releasedPlatforms: ['macos'] });
    expect(getRemoteControlCapabilities(2, env).desktopHostEnabled).toBe(false);
    expect(getRemoteControlCapabilities(undefined, env).desktopHostEnabled).toBe(false);
  });
  it.each(['*', '1,', '0,1', '-1,1', '1, 4', '01', Array(21).fill('1').join(',')])('配置不明确时不开放：%s', configured => {
    expect(getRemoteControlCapabilities(1, { REMOTE_CONTROL_PREVIEW_USER_IDS: configured }).desktopHostEnabled).toBe(false);
  });
});
