import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkProductVersion, parseProductVersion, planVersionSync, repositoryRoot, syncProductVersion } from './product-version.mjs';

const files = ['package.json', 'client-vue/package.json', 'backend-koa/package.json', 'client-vue/src-tauri/tauri.conf.json', 'client-vue/src-tauri/tauri.macos.conf.json', 'client-vue/src-tauri/Cargo.toml', 'client-vue/src-tauri/Cargo.lock', 'client-vue/src-tauri/Info.plist'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'todesk-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repositoryRoot, file), join(root, file));
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.version = '0.2.0-alpha.1'; pkg.desktopBuildNumber = 1;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  syncProductVersion(root);
  return root;
}
function json(root, path) { return JSON.parse(readFileSync(join(root, path), 'utf8')); }

test('Windows CRLF 检出不被误判为版本漂移，且仍能同步新版本', t => {
  const root = fixture(t);
  for (const file of files) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  assert.equal(checkProductVersion(root).version, '0.2.0-alpha.1');
  syncProductVersion(root, '0.2.0-alpha.2');
  assert.deepEqual(checkProductVersion(root), { version: '0.2.0-alpha.2', buildNumber: 2 });
});

test('产品只接受可打包的规范内测版本', () => {
  assert.throws(() => parseProductVersion('0.8.0-beta.4'), /内测/);
  assert.equal(parseProductVersion('0.2.0-alpha.12').base, '0.2.0');
  for (const version of ['0.2.0', '0.2.0-rc.1', '0.2.0-alpha.0', '0.2.0-alpha.01', '01.2.0-alpha.1', '0.2.0-alpha.1\n', '0.2.0-alpha.1+1', '65536.0.0-alpha.1']) {
    assert.throws(() => parseProductVersion(version));
  }
});

test('同步三包、Tauri、Cargo锁文件与mac数字版本并保留依赖和权限', t => {
  const root = fixture(t);
  const dependencies = json(root, 'client-vue/package.json').dependencies;
  syncProductVersion(root, '0.3.0-alpha.1');
  assert.deepEqual(checkProductVersion(root), { version: '0.3.0-alpha.1', buildNumber: 2 });
  for (const file of files.slice(0, 4)) assert.equal(json(root, file).version, '0.3.0-alpha.1');
  assert.deepEqual(json(root, 'client-vue/package.json').dependencies, dependencies);
  assert.equal(json(root, 'client-vue/src-tauri/tauri.macos.conf.json').bundle.macOS.bundleVersion, '2');
  const plist = readFileSync(join(root, 'client-vue/src-tauri/Info.plist'), 'utf8');
  assert.match(plist, /CFBundleShortVersionString<\/key>\s*<string>0\.3\.0<\/string>/);
  assert.match(plist, /内测版 0\.3\.0-alpha\.1/);
  assert.match(plist, /NSMicrophoneUsageDescription/);
  assert.match(readFileSync(join(root, 'client-vue/src-tauri/Cargo.lock'), 'utf8'), /name = "nearlink-desktop"\nversion = "0.3.0-alpha.1"/);
});

test('重复同步和设置同版本不会虚增数字构建号', t => {
  const root = fixture(t);
  assert.equal(syncProductVersion(root).changes.length, 0);
  assert.equal(syncProductVersion(root, '0.2.0-alpha.1').changes.length, 0);
  assert.equal(checkProductVersion(root).buildNumber, 1);
});

test('alpha按数值递增、patch/minor升级都会单次递增构建号', t => {
  const root = fixture(t);
  for (const version of ['0.2.0-alpha.10', '0.2.1-alpha.1', '0.3.0-alpha.1']) syncProductVersion(root, version);
  assert.equal(checkProductVersion(root).buildNumber, 4);
  assert.throws(() => syncProductVersion(root, '0.2.0-alpha.11'), /不能回退/);
  assert.equal(checkProductVersion(root).version, '0.3.0-alpha.1');
});

test('check发现每个版本来源的独立漂移且不修改文件', t => {
  for (const file of files.slice(1)) {
    const root = fixture(t);
    const path = join(root, file);
    const original = readFileSync(path, 'utf8');
    const drift = file.endsWith('tauri.macos.conf.json') ? original.replace('"bundleVersion": "1"', '"bundleVersion": "2"')
      : file.endsWith('Info.plist') ? original.replace('<string>0.2.0</string>', '<string>0.1.0</string>')
      : original.replace('0.2.0-alpha.1', '0.1.0-alpha.1');
    assert.notEqual(drift, original);
    writeFileSync(path, drift);
    assert.throws(() => checkProductVersion(root), /版本不一致/);
    assert.equal(readFileSync(path, 'utf8'), drift);
  }
});

test('字段损坏在写入前失败，不留下部分更新', t => {
  const root = fixture(t);
  const rootBefore = readFileSync(join(root, 'package.json'), 'utf8');
  const lockPath = join(root, 'client-vue/src-tauri/Cargo.lock');
  writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('name = "nearlink-desktop"', 'name = "missing-package"'));
  assert.throws(() => syncProductVersion(root, '0.3.0-alpha.1'), /缺少预期/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), rootBefore);
});

test('非法及耗尽的数字构建号在写入前拒绝', t => {
  for (const buildNumber of [0, -1, 1.5, 10000, 9999]) {
    const root = fixture(t);
    const pkg = json(root, 'package.json'); pkg.desktopBuildNumber = buildNumber;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    assert.throws(() => planVersionSync(root, '0.2.0-alpha.2'), /构建号|desktopBuildNumber/);
  }
});
