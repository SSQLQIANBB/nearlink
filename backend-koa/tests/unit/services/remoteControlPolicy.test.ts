import { describe, expect, it } from 'vitest';
import { getRemoteControlCapabilities } from '../../../src/services/remoteControlPolicy';

describe('远控平台能力', () => {
  it('提供桌面主控、被控和网页主控能力', () => {
    expect(getRemoteControlCapabilities()).toMatchObject({
      desktopHostEnabled: true,
      desktopControllerEnabled: true,
      webControllerReleaseEnabled: true,
      releasedPlatforms: ['macos', 'windows'],
      engineRequired: true,
      reason: 'READY',
    });
  });
});
