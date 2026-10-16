import { expect, it } from 'vitest';
import { selectDesktopRelease } from '../../../src/services/desktopRelease';
function release(version: string, draft = false) {
  return {
    tag_name: `desktop-v${version}`,
    draft,
    prerelease: true,
    published_at: '2026-10-17T00:00:00Z',
    assets: ['x64-setup.exe', 'aarch64.dmg', 'x64.dmg', 'SHA256SUMS.txt'].map((suffix) => {
      const name = suffix === 'SHA256SUMS.txt' ? suffix : `NearLink_${version}_${suffix}`;
      return {
        name,
        state: 'uploaded',
        size: 1234,
        browser_download_url: `https://github.com/SSQLQIANBB/nearlink/releases/download/desktop-v${version}/${name}`,
      };
    }),
  };
}
it('selects public alpha releases by semantic version, not API order or lexical order', () => {
  expect(
    selectDesktopRelease([
      release('0.12.0-alpha.2'),
      release('0.12.0-alpha.10'),
      release('0.11.0-alpha.100'),
    ])?.version,
  ).toBe('0.12.0-alpha.10');
});
it('excludes drafts, incomplete installers and missing checksum artifacts', () => {
  const missing = release('0.13.0-alpha.1');
  missing.assets.pop();
  const incomplete = release('0.14.0-alpha.1');
  incomplete.assets.shift();
  expect(
    selectDesktopRelease([
      release('0.15.0-alpha.1', true),
      missing,
      incomplete,
      release('0.12.0-alpha.1'),
    ])?.version,
  ).toBe('0.12.0-alpha.1');
});
it('rejects substituted asset hosts and non-desktop tags', () => {
  const wrongHost = release('0.12.0-alpha.1');
  wrongHost.assets[0].browser_download_url = 'https://evil.example/installer.exe';
  const wrongTag = release('0.12.0-alpha.2');
  wrongTag.tag_name = 'v0.12.0-alpha.2';
  expect(selectDesktopRelease([wrongHost, wrongTag])).toBeNull();
});
