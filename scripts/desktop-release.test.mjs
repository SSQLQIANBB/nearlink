import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDesktopRelease } from './desktop-release.mjs';
const cargo = version => `[package]\nname = "nearlink-desktop"\nversion = "${version}"\n\n[dependencies]\ntauri = "2"`;
test('当前所有安装包只能发布为内测版', () => {
  assert.throws(() => validateDesktopRelease({ version: '0.8.0-beta.4' }, cargo('0.8.0-beta.4'), 'desktop-v0.8.0-beta.4'), /内测/);
  assert.deepEqual(validateDesktopRelease({ version: '0.2.0-alpha.1' }, cargo('0.2.0-alpha.1'), 'desktop-v0.2.0-alpha.1'), { version: '0.2.0-alpha.1', prerelease: true });
  assert.throws(() => validateDesktopRelease({ version: '0.2.0' }, cargo('0.2.0'), 'desktop-v0.2.0'), /内测/);
});
test('阻止标签或 Rust 版本不一致的安装包发布', () => {
  assert.throws(() => validateDesktopRelease({ version: '0.2.0-alpha.1' }, cargo('0.2.0-alpha.1'), 'desktop-v0.2.0'), /标签/);
  assert.throws(() => validateDesktopRelease({ version: '0.2.0-alpha.1' }, cargo('0.2.0-alpha.2'), 'desktop-v0.2.0-alpha.1'), /不一致/);
});
test('拒绝不合法版本号', () => {
  for (const version of ['01.0.0', '1.0', '1.0.0-alpha.01', '1.0.0\n', '1.0.0+build']) {
    assert.throws(() => validateDesktopRelease({ version }, cargo(version), `desktop-v${version}`));
  }
});
