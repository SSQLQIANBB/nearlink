import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { options } from './remote-control-desktop-build.mjs';
test('default installer build rejects a missing engine', () => {
  assert.throws(() => options([]), /--bundle/);
});
test('explicit selection resolves at build time and preserves normal Tauri options', () => {
  assert.deepEqual(
    options(['--bundle', './candidate', '--plan', '--', '--debug', '--bundles', 'app']),
    { bundle: path.resolve('./candidate'), plan: true, dev: false, tauri: ['--debug', '--bundles', 'app'] },
  );
});
test('resource overrides and development harness selection cannot enter packaged builds', () => {
  for (const args of [
    ['--', '--config', 'other.json'],
    ['--', '-c=other.json'],
    ['--', '--features=remote-control-harness'],
    ['--bundle'],
    ['--dev'],
    ['--bundle', 'one', '--bundle', 'two'],
  ])
    assert.throws(() => options(args));
});

test('development uses the same explicit bundle selection', () => {
  assert.deepEqual(options(['--dev', '--bundle', './candidate']), {
    bundle: path.resolve('./candidate'), plan: false, dev: true, tauri: [],
  });
});

test('installer plans map each supported architecture to bundled resources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nearlink-engine-plan-'));
  try {
    for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
        format: 'todesk-engine-bundle-v1', target,
        entrypoint: `bin/remote-control-engine${target.includes('windows') ? '.exe' : ''}`,
      }));
      const result = spawnSync(process.execPath, ['scripts/remote-control-desktop-build.mjs', '--bundle', directory, '--plan'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.deepEqual(Object.values(plan.config.bundle.resources), ['remote-control-engine/']);
      assert.match(plan.manifestSha256, /^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('installer hook rejects an absent engine or a missing manifest', () => {
  const env = { ...process.env };
  delete env.TODE_REMOTE_ENGINE_BUNDLE;
  const run = () => spawnSync(process.execPath, ['scripts/remote-control-require-engine.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(run().status, 0);
  env.TODE_REMOTE_ENGINE_BUNDLE = path.resolve('does-not-exist-engine');
  assert.notEqual(run().status, 0);
});
