import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'assets/branding/todesk-icon.png');
const cli = join(root, 'client-vue/node_modules/@tauri-apps/cli/tauri.js');
const temporary = mkdtempSync(join(tmpdir(), 'todesk-icons-'));
const desktop = join(root, 'client-vue/src-tauri/icons');
const web = join(root, 'client-vue/public');

try {
  // 使用同一份原图生成平台资源，只保留项目实际需要的文件。
  execFileSync(process.execPath, [cli, 'icon', source, '--output', temporary], { stdio: 'pipe' });
  mkdirSync(desktop, { recursive: true });
  for (const name of [
    '32x32.png',
    '128x128.png',
    '128x128@2x.png',
    'icon.png',
    'icon.ico',
    'icon.icns',
  ]) {
    copyFileSync(join(temporary, name), join(desktop, name));
  }
  copyFileSync(join(temporary, 'icon.ico'), join(web, 'favicon.ico'));
  copyFileSync(join(temporary, '32x32.png'), join(web, 'favicon.png'));
  copyFileSync(join(temporary, '128x128@2x.png'), join(web, 'app-icon.png'));
  execFileSync(process.execPath, [cli, 'icon', source, '--output', temporary, '--png', '180'], {
    stdio: 'pipe',
  });
  copyFileSync(join(temporary, '180x180.png'), join(web, 'apple-touch-icon.png'));
  // 兼容仍引用旧 SVG 地址的页面，避免旧标识继续被使用。
  const data = readFileSync(join(web, 'app-icon.png')).toString('base64');
  writeFileSync(
    join(web, 'favicon.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,${data}"/></svg>\n`,
  );
  console.log('已从品牌原图生成 Web、macOS 和 Windows 图标。');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
