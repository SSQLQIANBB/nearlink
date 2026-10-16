#!/usr/bin/env node
// Build-time preparation only. Runtime still verifies the compiled manifest.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, readdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareDevelopmentSigning } from './remote-control-dev-signing.mjs';

const capture = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(scripts);
const windows = process.platform === 'win32';
const packages = ['gstreamer-libs', 'gstreamer-plugins', 'gstreamer-plugins-libs', 'gstreamer-python'];
if (windows) packages.push('gstreamer-ext-runtime');
const sdkVersion = '1.28.7';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error.code === 'ENOENT'
        ? new Error(`找不到开发工具 ${command}。请安装 Windows CPython 3.13（包含 py 启动器）或 macOS CPython 3.13.2，并重新打开终端。`)
        : error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${signal ?? `退出码 ${code}`}；远控开发启动已停止。`));
    });
  });
}

export async function prepareEngine() {
  if (!(windows && process.arch === 'x64') && !(process.platform === 'darwin' && process.arch === 'arm64')) {
    throw new Error('本机远控开发支持 Windows x64 / macOS Apple 芯片。普通聊天开发可运行 npm run desktop:dev:chat。');
  }
  const env = { ...process.env };
  if (windows) {
    console.log('[远控] 加载 MSVC x64 编译环境…');
    const { stdout } = await capture('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'remote-control-dev-msvc.ps1')], { windowsHide: true });
    const compilerEnv = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    // Windows environment names are case-insensitive; Node must not receive both PATH and Path.
    for (const key of Object.keys(env)) {
      if (Object.keys(compilerEnv).some((name) => name.toLowerCase() === key.toLowerCase())) delete env[key];
    }
    Object.assign(env, compilerEnv);
  }
  const cache = path.join(repository, 'dist', 'remote-control-dev', `${process.platform}-${process.arch}`);
  await mkdir(cache, { recursive: true });
  // Reuse the isolated SDK previously prepared for this Windows project.
  const existingSdk = windows && env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'NearLink', 'remote-engine-dev', 'Scripts', 'python.exe') : null;
  const venv = path.join(cache, 'sdk');
  const python = existingSdk && await exists(existingSdk) ? existingSdk
    : path.join(venv, windows ? 'Scripts/python.exe' : 'bin/python');
  if (!(await exists(python))) {
    console.log('[远控] 创建隔离 Python 3.13 环境（macOS 要求 3.13.2 framework 版本）…');
    await run(env.TODE_ENGINE_BUILD_PYTHON || (windows ? 'py' : 'python3.13'), [...(windows && !env.TODE_ENGINE_BUILD_PYTHON ? ['-3.13'] : []), '-m', 'venv', venv], env);
  }
  const query = `import sys,json,importlib.metadata as m
names=json.loads(sys.argv[1])
versions={}
for name in names:
 try: versions[name]=m.version(name)
 except m.PackageNotFoundError: versions[name]=None
print(json.dumps({'version':list(sys.version_info[:3]),'base':sys.base_prefix,'packages':versions}))`;
  const { stdout } = await capture(python, ['-c', query, JSON.stringify(packages)], { env });
  const sdk = JSON.parse(stdout);
  if (sdk.version[0] !== 3 || sdk.version[1] !== 13 || (!windows && sdk.version[2] !== 2)) {
    throw new Error('引擎构建需要 Windows CPython 3.13 或 macOS CPython 3.13.2；请使用对应的开发环境。');
  }
  if (packages.some((name) => sdk.packages[name] !== sdkVersion)) {
    console.log('[远控] 安装固定版本 GStreamer 开发依赖，首次准备需要下载…');
    await run(python, ['-m', 'pip', 'install', '--only-binary=:all:', ...packages.map((name) => `${name}==${sdkVersion}`)], env);
  }
  const hash = createHash('sha256').update(JSON.stringify({ version: sdk.version, base: sdk.base, sdkVersion, platform: process.platform, arch: process.arch }));
  const sources = (await readdir(scripts)).filter((name) =>
    /^(remote-control|package-remote-control-engine).*\.(py|c|swift|mjs|ps1)$/.test(name) || name === 'remote_control_ipc.py').sort();
  for (const name of sources) hash.update(name).update(await readFile(path.join(scripts, name)));
  const bundle = path.join(cache, `engine-${hash.digest('hex').slice(0, 24)}`);
  if (!(await exists(path.join(bundle, 'manifest.json')))) {
    console.log('[远控] 从当前源码生成引擎资源…');
    const packager = path.join(scripts, windows ? 'package-remote-control-engine-windows.py' : 'package-remote-control-engine.py');
    const staging = await mkdtemp(path.join(cache, 'preparing-'));
    try {
      const output = path.join(staging, 'engine');
      await run(python, [packager, ...(windows ? [] : ['--sdk-python', python]), '--output', output], env);
      await rename(output, bundle);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    console.log('[远控] 复用当前源码对应的引擎资源。');
  }
  return { bundle, env };
}

async function main() {
  const { bundle, env } = await prepareEngine();
  const publicKeyFile = await prepareDevelopmentSigning(repository);
  if (publicKeyFile) env.TODE_REMOTE_DEV_PUBLIC_KEY = publicKeyFile;
  console.log('[远控] 启动包含引擎的桌面客户端；实际能力仍取决于系统权限和服务端配置。');
  await run(process.execPath, [path.join(scripts, 'remote-control-desktop-build.mjs'), '--dev', '--bundle', bundle, '--', ...process.argv.slice(2)], env);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`[远控] ${error.message}`);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
