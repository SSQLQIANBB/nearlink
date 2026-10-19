#!/usr/bin/env node
// Native test binaries use --no-bundle; every distributable installer needs an engine.
import { access } from 'node:fs/promises';
import path from 'node:path';

const bundle = process.env.TODE_REMOTE_ENGINE_BUNDLE;
if (!bundle || !path.isAbsolute(bundle)) {
  console.error('安装包必须包含远控引擎。请使用 pnpm desktop:build，或 pnpm desktop:remote:build --bundle <绝对路径>。');
  process.exitCode = 1;
} else {
  await access(path.join(bundle, 'manifest.json'));
}
