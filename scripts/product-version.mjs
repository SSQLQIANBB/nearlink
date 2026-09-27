import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePaths = ['package.json', 'client-vue/package.json', 'backend-koa/package.json'];

export function parseProductVersion(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/.exec(version);
  if (!match) throw new Error('当前内测版本必须为 major.minor.patch-beta.N，例如 0.2.0-beta.1');
  const parts = match.slice(1).map(Number);
  if (parts.some(value => !Number.isSafeInteger(value)) || parts.slice(0, 3).some(value => value > 65535)) {
    throw new Error('版本数值超出桌面平台范围（主、次、修订版本不得超过 65535）');
  }
  return { version, parts, base: parts.slice(0, 3).join('.') };
}

function replaceOne(text, expression, replacement, path) {
  if (!expression.test(text)) throw new Error(`${path} 缺少预期版本字段`);
  return text.replace(expression, replacement);
}

function plistValue(text, key, value) {
  const expression = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  return expression.test(text)
    ? text.replace(expression, (_, before, after) => `${before}${value}${after}`)
    : text.replace('</dict>', `  <key>${key}</key>\n  <string>${value}</string>\n</dict>`);
}

/** Prepare every edit before writing so malformed/missing files cannot leave a partial sync. */
export function planVersionSync(root, requestedVersion) {
  const changes = new Map();
  // Git on Windows may check out CRLF; line endings are not version changes.
  const read = path => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
  const json = path => JSON.parse(read(path));
  const rootPackage = json('package.json');
  const current = parseProductVersion(rootPackage.version);
  const next = parseProductVersion(requestedVersion ?? current.version);
  let buildNumber = rootPackage.desktopBuildNumber;
  if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 9999) {
    throw new Error('package.json 的 desktopBuildNumber 必须为 1 至 9999 的递增整数');
  }
  if (next.version !== current.version) {
    const different = next.parts.findIndex((part, index) => part !== current.parts[index]);
    if (next.parts[different] < current.parts[different]) throw new Error('新版本必须高于当前版本，不能回退已分配的版本号');
    if (++buildNumber > 9999) throw new Error('数字构建号已达上限，需要先调整平台版本策略');
  }
  const putJson = (path, value) => changes.set(path, `${JSON.stringify(value, null, 2)}\n`);
  for (const path of packagePaths) {
    const data = path === 'package.json' ? rootPackage : json(path);
    data.version = next.version;
    if (path === 'package.json') data.desktopBuildNumber = buildNumber;
    putJson(path, data);
  }
  const configPath = 'client-vue/src-tauri/tauri.conf.json';
  const config = json(configPath);
  config.version = next.version;
  const mainWindow = config.app.windows.find(window => window.label === 'main');
  if (!mainWindow) throw new Error('Tauri 缺少 main 窗口');
  mainWindow.title = `ToDesk 内测版 ${next.version}`;
  putJson(configPath, config);
  const macPath = 'client-vue/src-tauri/tauri.macos.conf.json';
  const mac = json(macPath);
  mac.bundle.macOS.bundleVersion = String(buildNumber);
  putJson(macPath, mac);
  const cargoPath = 'client-vue/src-tauri/Cargo.toml';
  changes.set(cargoPath, replaceOne(read(cargoPath), /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("[^\n]*)/, `$1${next.version}$2`, cargoPath));
  const lockPath = 'client-vue/src-tauri/Cargo.lock';
  changes.set(lockPath, replaceOne(read(lockPath), /(\[\[package\]\]\nname = "todesk-desktop"\nversion = ")[^"]+(")/, `$1${next.version}$2`, lockPath));
  const plistPath = 'client-vue/src-tauri/Info.plist';
  changes.set(plistPath, plistValue(plistValue(read(plistPath), 'CFBundleShortVersionString', next.base), 'CFBundleGetInfoString', `ToDesk 内测版 ${next.version}`));
  return { version: next.version, buildNumber, changes: [...changes].filter(([path, value]) => value !== read(path)) };
}

export function checkProductVersion(root = repositoryRoot) {
  const result = planVersionSync(root);
  if (result.changes.length) throw new Error(`产品版本不一致，请运行 pnpm version:sync：\n${result.changes.map(([path]) => path).join('\n')}`);
  return { version: result.version, buildNumber: result.buildNumber };
}

export function syncProductVersion(root = repositoryRoot, version) {
  const result = planVersionSync(root, version);
  for (const [path, value] of result.changes) writeFileSync(resolve(root, path), value);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, version, ...extra] = process.argv.slice(2);
  if (extra.length || !['check', 'sync', 'set'].includes(command) || (command === 'set') !== Boolean(version)) {
    throw new Error('用法：product-version.mjs check | sync | set 0.2.0-beta.1');
  }
  const result = command === 'check' ? checkProductVersion() : syncProductVersion(repositoryRoot, version);
  console.log(`产品内测版本${command === 'check' ? '校验通过' : '已同步'}：${result.version}（构建号 ${result.buildNumber}）`);
}
