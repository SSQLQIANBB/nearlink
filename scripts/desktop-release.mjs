import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkProductVersion, parseProductVersion } from './product-version.mjs';

export function validateDesktopRelease(config, cargo, tag) {
  const version = config.version;
  parseProductVersion(version);
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (cargoVersion !== version) throw new Error('Cargo.toml 与 tauri.conf.json 的版本号不一致');
  if (tag !== `desktop-v${version}`) throw new Error(`标签必须为 desktop-v${version}`);
  return { version, prerelease: version.includes('-') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkProductVersion();
  const config = JSON.parse(
    readFileSync(new URL('../client-vue/src-tauri/tauri.conf.json', import.meta.url)),
  );
  const cargo = readFileSync(
    new URL('../client-vue/src-tauri/Cargo.toml', import.meta.url),
    'utf8',
  );
  const result = validateDesktopRelease(config, cargo, process.argv[2]);
  console.log(`桌面版本校验通过：${result.version}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nprerelease=${result.prerelease}\n`,
    );
  }
}
