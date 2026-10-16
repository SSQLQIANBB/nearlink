import { describe, expect, it, vi } from 'vitest';
vi.mock('@/utils/api', () => ({ API_BASE_URL: '/api' }));
import { browserPlatform, compareVersions, validRelease } from '@/services/desktopRelease';
describe('desktop release selection', () => {
  it('compares prerelease numbers numerically and never downgrades beta or newer versions', () => {
    expect(compareVersions('0.12.0-alpha.10', '0.12.0-alpha.2')).toBe(1);
    expect(compareVersions('0.12.0-alpha.2', '0.12.0-beta.1')).toBe(-1);
    expect(compareVersions('0.11.0-alpha.100', '0.12.0-alpha.1')).toBe(-1);
    expect(compareVersions('0.12.0-alpha.1', '0.12.0-alpha.1')).toBe(0);
    expect(compareVersions('invalid', '0.12.0-alpha.1')).toBe(0);
  });
  it('recommends known Windows x64 without guessing Mac chip or mobile support', () => {
    expect(browserPlatform('Windows NT 10.0; Win64; x64')).toBe('windows-x64');
    expect(browserPlatform('Macintosh; Intel Mac OS X', 'MacIntel')).toBeNull();
    expect(browserPlatform('Macintosh; Intel Mac OS X', 'MacIntel', 5)).toBeNull();
    expect(browserPlatform('Windows NT 10.0; ARM64')).toBeNull();
    expect(browserPlatform('Android')).toBeNull();
    expect(browserPlatform('Linux x86_64')).toBeNull();
  });
  it('rejects injected download locations', () => {
    expect(
      validRelease({
        version: '0.12.0-alpha.1',
        assets: { 'windows-x64': { url: 'https://evil.example' } },
      } as never),
    ).toBe(false);
  });
});

it('coalesces checks, exposes network errors and can recover without a false update', async () => {
  const service = await import('@/services/desktopRelease');
  let finish!: (value: unknown) => void;
  const fetchMock = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const first = service.checkDesktopRelease(true);
    const second = service.checkDesktopRelease(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish({ ok: true, json: async () => ({ release: null }) });
    await Promise.all([first, second]);
    expect(service.release.value).toBeNull();
    expect(service.releaseError.value).toBe('');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await service.checkDesktopRelease(true);
    expect(service.releaseError.value).toContain('重试');
    expect(service.hasUpdate.value).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ release: null }) });
    await service.checkDesktopRelease(true);
    expect(service.releaseError.value).toBe('');
    expect(service.releaseLoading.value).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
