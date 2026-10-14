import { describe, expect, it } from 'vitest';
import { isVoiceActive } from '../../../src/services/speakingDetector';
import { containedVideoRect } from '../../../src/services/annotationGeometry';

describe('发言检测', () => {
  it('静音和微弱噪声不亮标记，明显音量亮标记', () => {
    expect(isVoiceActive(new Uint8Array(512).fill(128))).toBe(false);
    expect(isVoiceActive(new Uint8Array(512).fill(129))).toBe(false);
    expect(isVoiceActive(new Uint8Array(512).fill(150))).toBe(true);
    expect(isVoiceActive(new Uint8Array())).toBe(false);
  });
});
describe('共享标注布局', () => {
  it('不同窗口按视频比例留出黑边，标注区域与画面一致', () => {
    const rect = containedVideoRect({ width: 1000, height: 1000 }, { width: 1920, height: 1080 });
    expect(rect.width).toBeCloseTo(1000);
    expect(rect.height).toBeCloseTo(562.5);
    expect(containedVideoRect({ width: 800, height: 450 }, { width: 1920, height: 1080 })).toEqual({
      width: 800,
      height: 450,
    });
  });
});
