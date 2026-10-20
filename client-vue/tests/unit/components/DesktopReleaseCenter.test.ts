import { afterEach, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';

vi.mock('@/utils/api', () => ({ API_BASE_URL: '/api' }));
vi.mock('@/services/desktopRelease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktopRelease')>()),
  desktop: true,
  checkDesktopRelease: vi.fn().mockResolvedValue(undefined),
}));

import DesktopReleaseCenter from '@/components/DesktopReleaseCenter.vue';
import { checkDesktopRelease } from '@/services/desktopRelease';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('checks on entry without querying again on focus or elapsed time', async () => {
  vi.useFakeTimers();
  const wrapper = shallowMount(DesktopReleaseCenter);
  try {
    expect(checkDesktopRelease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(checkDesktopRelease).toHaveBeenCalledTimes(1);
  } finally {
    wrapper.unmount();
  }
});
