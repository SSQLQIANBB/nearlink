#!/usr/bin/env node
/** Optional build-time resource selection. Runtime paths never come from here. */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function options(argv) {
  let bundle = null;
  let plan = false;
  let dev = false;
  const tauri = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') {
      if (bundle !== null || !argv[i + 1] || argv[i + 1].startsWith('--'))
        throw new Error('--bundle requires exactly one path');
      bundle = path.resolve(argv[++i]);
    } else if (argv[i] === '--plan') plan = true;
    else if (argv[i] === '--dev') dev = true;
    else if (argv[i] === '--') {
      tauri.push(...argv.slice(i + 1));
      break;
    } else throw new Error(`Unknown wrapper option: ${argv[i]}`);
  }
  if (
    tauri.some(
      (arg) =>
        arg === '--config' ||
        arg.startsWith('--config=') ||
        arg === '-c' ||
        arg.startsWith('-c=') ||
        arg.includes('remote-control-harness'),
    )
  ) {
    throw new Error(
      'The wrapper owns the resource config and cannot build the development harness',
    );
  }
  if (dev && !bundle) throw new Error('--dev requires --bundle with a platform engine bundle');
  if (!dev && !bundle) throw new Error('桌面安装包必须使用 --bundle 指定对应平台的远控引擎；仅聊天构建请使用 desktop:build:chat');
  return { bundle, plan, dev, tauri };
}
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.join(repository, 'client-vue'),
      env,
      stdio: 'inherit',
    });
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const finish = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => {
      finish();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      finish();
      code === 0 ? resolve() : reject(new Error(`Desktop build ${signal ?? `exited ${code}`}`));
    });
  });
}
async function main() {
  const selected = options(process.argv.slice(2));
  const env = { ...process.env };
  // An ambient previous selection must not silently change a default build.
  delete env.TODE_REMOTE_ENGINE_BUNDLE;
  let config = null;
  let digest = null;
  if (selected.bundle) {
    selected.bundle = await realpath(selected.bundle);
    const bytes = await readFile(path.join(selected.bundle, 'manifest.json'));
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Engine manifest exceeds the size limit');
    const manifest = JSON.parse(bytes);
    if (
      manifest.format !== 'todesk-engine-bundle-v1' ||
      !['aarch64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(manifest.target) ||
      manifest.entrypoint !== (manifest.target === 'x86_64-pc-windows-msvc'
        ? 'bin/remote-control-engine.exe' : 'bin/remote-control-engine')
    )
      throw new Error('Unsupported engine manifest');
    digest = createHash('sha256').update(bytes).digest('hex');
    config = {
      bundle: { resources: { [`${selected.bundle}${path.sep}`]: 'remote-control-engine/' } },
    };
    env.TODE_REMOTE_ENGINE_BUNDLE = selected.bundle;
  }
  if (selected.plan) {
    console.log(
      JSON.stringify(
        {
          bundle: selected.bundle,
          manifestSha256: digest,
          config,
          tauriArgs: selected.tauri,
          command: selected.dev ? 'dev' : 'build',
          capabilitiesEnabled: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'todesk-engine-build-'));
  try {
    await run(
      process.execPath,
      [path.join(repository, 'scripts/product-version.mjs'), 'check'],
      env,
    );
    const args = [path.join(repository, 'client-vue/node_modules/@tauri-apps/cli/tauri.js'), selected.dev ? 'dev' : 'build'];
    if (config) {
      const configPath = path.join(temporary, 'engine-resources.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      args.push('--config', configPath);
    }
    args.push(...selected.tauri);
    await run(process.execPath, args, env);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
