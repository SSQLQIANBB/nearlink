// A small inherited-pipe test adapter for the system WKWebView, not Playwright WebKit.
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

export async function createWkBrowser(directory) {
  if (process.platform !== 'darwin') throw new Error('WKWebView regression requires macOS');
  const executable = join(directory, 'wkwebview-probe');
  await promisify(execFile)(
    'xcrun',
    [
      'swiftc',
      '-parse-as-library',
      fileURLToPath(new URL('./remote-control-wkwebview.swift', import.meta.url)),
      '-o',
      executable,
    ],
    { timeout: 60000 },
  );
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map(),
    callbacks = new Map();
  let sequence = 0,
    closed = false,
    stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const fail = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  const exited = new Promise((resolve) =>
    child.once('close', (code) => {
      closed = true;
      fail(new Error(`WKWebView exited ${code}: ${stderr}`));
      resolve();
    }),
  );
  lines.on('line', (line) => {
    try {
      if (line.length > 262144) throw new Error('WKWebView response exceeds limit');
      const value = JSON.parse(line);
      if (value.fatal) throw new Error(value.fatal);
      if (value.event) {
        callbacks.get(value.event)?.(value.argument);
        return;
      }
      const entry = pending.get(value.id);
      if (!entry) return;
      pending.delete(value.id);
      clearTimeout(entry.timer);
      if (value.error) entry.reject(new Error(value.error));
      else entry.resolve(value.result);
    } catch (error) {
      fail(error);
    }
  });
  const command = (method, fields = {}) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('WKWebView closed'));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`WKWebView ${method} timeout: ${stderr}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, ...fields })}\n`);
    });
  const page = {
    bringToFront: () => command('focus'),
    goto: (url) => command('goto', { url }),
    evaluate: (fn, argument) =>
      command('evaluate', { code: fn.toString(), argument: argument ?? null }),
    async exposeFunction(name, callback) {
      if (name !== 'sendHostSignal') throw new Error('Unknown WKWebView test callback');
      callbacks.set(name, callback);
      await this.evaluate((name) => {
        window[name] = (argument) =>
          window.webkit.messageHandlers.probe.postMessage({ name, argument });
      }, name);
    },
  };
  return {
    newPage: async () => page,
    async close() {
      if (!closed) {
        await command('close').catch(() => {});
        child.stdin.end();
      }
      let timer;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
      lines.close();
      callbacks.clear();
    },
  };
}
