import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppInBackground } from '../../../src/services/appVisibility';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('桌面前后台判断', () => {
  it('网页保持可见标签页的原行为', () => {
    vi.stubGlobal('isTauri', false);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(isAppInBackground()).toBe(false);
  });

  it('桌面切换到其他应用后也应通知，重新聚焦后停止通知', () => {
    vi.stubGlobal('isTauri', true);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(isAppInBackground()).toBe(true);
    focused.mockReturnValue(true);
    expect(isAppInBackground()).toBe(false);
  });

  it('隐藏或最小化时判定为后台', () => {
    vi.stubGlobal('isTauri', true);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(isAppInBackground()).toBe(true);
  });
});
