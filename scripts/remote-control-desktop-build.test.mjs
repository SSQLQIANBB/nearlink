import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { options } from './remote-control-desktop-build.mjs';
test('default build requires no implicit engine selection', () => {
  assert.deepEqual(options([]), { bundle: null, plan: false, dev: false, tauri: [] });
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
