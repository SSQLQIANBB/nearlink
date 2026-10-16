#!/usr/bin/env node
// Installer preparation never creates or embeds development signing keys.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareEngine } from './remote-control-desktop-dev.mjs';

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.includes('--bundle');
  const prepared = explicit ? { env: { ...process.env } } : await prepareEngine();
  delete prepared.env.TODE_REMOTE_DEV_PUBLIC_KEY;
  delete prepared.env.TODE_REMOTE_ENGINE_BUNDLE;
  const wrapper = fileURLToPath(new URL('./remote-control-desktop-build.mjs', import.meta.url));
  const selection = explicit ? args : ['--bundle', prepared.bundle, '--', ...args.filter((arg, index) => !(index === 0 && arg === '--'))];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...selection], { env: prepared.env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      code === 0 ? resolve() : reject(new Error(`桌面打包失败：${signal ?? code}`));
    });
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
