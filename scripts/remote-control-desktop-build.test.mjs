import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { options } from './remote-control-desktop-build.mjs';
test('default build requires no implicit engine selection', () => {
  assert.deepEqual(options([]), { bundle: null, plan: false, tauri: [] });
});
test('explicit selection resolves at build time and preserves normal Tauri options', () => {
  assert.deepEqual(
    options(['--bundle', './candidate', '--plan', '--', '--debug', '--bundles', 'app']),
    { bundle: path.resolve('./candidate'), plan: true, tauri: ['--debug', '--bundles', 'app'] },
  );
});
test('resource overrides and development harness selection cannot enter packaged builds', () => {
  for (const args of [
    ['--', '--config', 'other.json'],
    ['--', '-c=other.json'],
    ['--', '--features=remote-control-harness'],
    ['--bundle'],
    ['--bundle', 'one', '--bundle', 'two'],
  ])
    assert.throws(() => options(args));
});
