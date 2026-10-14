// Development-only real screen/DTLS check for the MAC-supervised engine.
// Keys travel solely through inherited stdin. No screen contents or SDP are saved.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(new URL('../client-vue/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const python = process.env.REMOTE_CONTROL_PROBE_PYTHON;
if (!python) throw new Error('Set REMOTE_CONTROL_PROBE_PYTHON to the temporary 1.28.7 SDK');
const stopMode =
  process.argv.find((value) => value.startsWith('--stop-mode='))?.split('=')[1] || 'lease';
if (!['lease', 'eof', 'heartbeat', 'stop'].includes(stopMode))
  throw new Error('Unsupported stop mode');
const directory = await mkdtemp(join(tmpdir(), 'todesk-supervised-engine-'));
const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const execute = promisify(execFile);
const key = randomBytes(32),
  launchId = randomBytes(32).toString('base64url'),
  sessionId = randomUUID();
let tx = 0,
  rx = 0,
  exited = false,
  exitCode,
  exitSignal,
  processError,
  ready,
  dtls,
  stopped,
  mediaStarted,
  page,
  browser,
  timer;
const events = [],
  channelMessages = [],
  channels = new Set();
let native,
  lines,
  errors = '',
  result;
const encode = (kind, payload) => {
  const body = Buffer.from(
    JSON.stringify({ sessionId, launchId, seq: ++tx, kind, payload }),
  ).toString('base64url');
  return `${JSON.stringify({ format: 'rc-ipc-v1', payload: body, mac: createHmac('sha256', key).update(`todesk-host-ipc/v1\nsupervisor-to-engine\n${body}`).digest('base64url') })}\n`;
};
const decode = (line) => {
  if (line.length > 131072) throw new Error('IPC line too large');
  const envelope = JSON.parse(line);
  const expected = createHmac('sha256', key)
    .update(`todesk-host-ipc/v1\nengine-to-supervisor\n${envelope.payload}`)
    .digest();
  const mac = Buffer.from(envelope.mac, 'base64url');
  if (envelope.format !== 'rc-ipc-v1' || mac.length !== 32 || !timingSafeEqual(mac, expected))
    throw new Error('Engine IPC MAC mismatch');
  const message = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString());
  if (message.sessionId !== sessionId || message.launchId !== launchId || message.seq !== ++rx)
    throw new Error('Engine IPC binding mismatch');
  return message;
};
const send = (kind, payload = {}) => {
  if (!exited && !native.stdin.destroyed) native.stdin.write(encode(kind, payload));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let exit;
async function pump() {
  if (processError) throw processError;
  while (events.length && page) {
    const event = events.shift();
    await page.evaluate(async ({ kind, payload }) => {
      const { pc, pending } = window.probe;
      if (kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        for (const ice of pending.splice(0)) await pc.addIceCandidate(ice);
      } else if (kind === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(payload);
        else pending.push(payload);
      }
    }, event);
  }
}
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await pump();
    if (await check()) return;
    if (exited)
      throw new Error(
        `Engine stopped before expected condition: ${JSON.stringify({ stopped, exitCode, exitSignal })} ${errors}`,
      );
    await sleep(25);
  }
  throw new Error(
    `Engine probe timed out: ${JSON.stringify({ ready, dtls, channels: [...channels], stopped, mediaStarted })} ${errors}`,
  );
}
try {
  const source = join(directory, 'screen-source');
  await execute(
    'xcrun',
    ['swiftc', '-parse-as-library', path('./remote-control-screen-source.swift'), '-o', source],
    { timeout: 60000 },
  );
  native = spawn(python, [path('./remote-control-host-engine.py'), '--screen-source', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  exit = new Promise((resolve) =>
    native.once('close', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    }),
  );
  native.on('error', (error) => {
    processError = error;
  });
  native.stdin.on('error', (error) => {
    if (!stopped && !exited) processError = error;
  });
  native.stderr.on('data', (data) => {
    errors = (errors + data.toString()).slice(-3000);
  });
  lines = createInterface({ input: native.stdout });
  lines.on('line', (line) => {
    try {
      const message = decode(line),
        { kind, payload } = message;
      if (kind === 'ready') ready = payload;
      else if (kind === 'dtls') dtls = payload;
      else if (kind === 'channel-open') channels.add(payload.label);
      else if (kind === 'channel-data') channelMessages.push(payload);
      else if (kind === 'media-started') mediaStarted = payload;
      else if (kind === 'stopped') stopped = payload;
      else events.push(message);
    } catch (error) {
      processError = error;
    }
  });
  native.stdin.write(
    `${JSON.stringify({ protocolVersion: 1, sessionId, launchId, key: key.toString('base64url') })}\n`,
  );
  timer = setInterval(() => send('heartbeat'), 400);
  await waitFor(() => !!ready);
  browser = await chromium.launch({
    headless: true,
    args: ['--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  page = await browser.newPage();
  await page.exposeFunction('signalEngine', ({ kind, payload }) => send(kind, payload));
  await page.setContent('<video autoplay muted playsinline></video>');
  await page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const video = document.querySelector('video');
    const state = pc.createDataChannel('rc-state-v1', { ordered: true });
    const input = pc.createDataChannel('rc-input-v1', { ordered: true });
    window.probe = { pc, state, input, pending: [], frames: 0, echoes: [] };
    const frame = () => {
      window.probe.frames++;
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
    pc.ontrack = ({ track }) => {
      video.srcObject = new MediaStream([track]);
    };
    state.onmessage = ({ data }) => {
      window.probe.echoes.push(data);
    };
    const loopback = (candidate) =>
      /^candidate:\S+ \d+ (?:udp|tcp) \d+ (?:127\.\d+\.\d+\.\d+|::1) \d+ typ host(?: |$)/i.test(
        candidate,
      );
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && loopback(candidate.candidate))
        window.signalEngine({
          kind: 'ice',
          payload: { candidate: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex },
        });
    };
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    transceiver.setCodecPreferences(
      RTCRtpReceiver.getCapabilities('video').codecs.filter(
        (codec) => codec.mimeType === 'video/H264',
      ),
    );
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = pc.localDescription.sdp
      .split('\r\n')
      .filter((line) => !line.startsWith('a=candidate:') || loopback(line.slice(2)))
      .join('\r\n');
    await window.signalEngine({ kind: 'offer', payload: { sdp } });
  });
  await waitFor(
    async () =>
      dtls &&
      channels.size === 2 &&
      (await page.evaluate(
        () =>
          window.probe.state.readyState === 'open' &&
          window.probe.pc.connectionState === 'connected',
      )),
  );
  const actual = await page.evaluate(async () => {
    const pc = window.probe.pc;
    const certificate = pc.sctp.transport.getRemoteCertificates()[0];
    return {
      hostCertificate: [...new Uint8Array(certificate)],
      controller: pc.localDescription.sdp
        .match(/a=fingerprint:sha-256 ([A-Fa-f0-9:]+)/)[1]
        .replaceAll(':', '')
        .toUpperCase(),
    };
  });
  const hostFingerprint = createHash('sha256')
    .update(Buffer.from(actual.hostCertificate))
    .digest('hex')
    .toUpperCase();
  if (hostFingerprint !== dtls.hostFingerprint || actual.controller !== dtls.controllerFingerprint)
    throw new Error('Actual DTLS certificate mismatch');
  await page.evaluate(() => {
    window.probe.state.send('prelease-state');
    window.probe.input.send('raw-input-forward-only');
  });
  await waitFor(() => channelMessages.length >= 2);
  const rawInput = channelMessages.find((value) => value.label === 'rc-input-v1');
  if (Buffer.from(rawInput.data, 'base64url').toString() !== 'raw-input-forward-only')
    throw new Error('Input bytes changed');
  send('send-channel', {
    label: 'rc-state-v1',
    data: Buffer.from('supervisor-state').toString('base64url'),
  });
  await waitFor(() => page.evaluate(() => window.probe.echoes.includes('supervisor-state')));
  await sleep(600);
  await pump();
  const preleaseFrames = await page.evaluate(() => window.probe.frames);
  if (preleaseFrames || mediaStarted)
    throw new Error('Capture started without supervisor authorization');
  const clock = BigInt(
    (
      await execute(python, [
        '-c',
        'import time; print(time.clock_gettime_ns(time.CLOCK_MONOTONIC))',
      ])
    ).stdout.trim(),
  );
  const startedAt = Date.now(),
    ttlMs = 6000;
  send('start-media', {
    mediaLeaseSeq: 1,
    ttlMs,
    monotonicDeadlineNs: String(clock + BigInt(ttlMs) * 1000000n),
  });
  await waitFor(() => page.evaluate(() => window.probe.frames >= 10), 7000);
  const frames = await page.evaluate(() => window.probe.frames);
  if (stopMode === 'eof') {
    clearInterval(timer);
    native.stdin.end();
  }
  if (stopMode === 'heartbeat') clearInterval(timer);
  if (stopMode === 'stop') send('stop');
  await Promise.race([
    exit,
    sleep(10000).then(() => {
      throw new Error('Engine did not stop');
    }),
  ]);
  clearInterval(timer);
  await sleep(300);
  const before = await page.evaluate(() => window.probe.frames);
  await sleep(400);
  const after = await page.evaluate(() => window.probe.frames);
  let childExited = true;
  if (mediaStarted?.screenPid) {
    try {
      process.kill(mediaStarted.screenPid, 0);
      childExited = false;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (exitCode !== 0 || !stopped?.captureStopped || !childExited || before !== after)
    throw new Error(
      `Failed supervised teardown: ${JSON.stringify({ exitCode, stopped, childExited, before, after })} ${errors}`,
    );
  if (
    stopMode === 'lease' &&
    !['MEDIA_LEASE_EXPIRED', 'SCREEN_BACKPRESSURE_OR_EXPIRED'].includes(stopped.reason)
  )
    throw new Error(`Unexpected termination ${stopped.reason}`);
  result = {
    status: 'passed',
    developmentOnly: true,
    stopMode,
    actualDtlsVerified: true,
    preleaseFrames,
    framesAfterAuthorization: frames,
    rawInputForwarded: true,
    screenStored: false,
    elapsedMs: Date.now() - startedAt,
    shutdown: stopped,
    framesStableAfterStop: before === after,
    childExited,
  };
} finally {
  clearInterval(timer);
  if (native && !exited) {
    native.kill('SIGTERM');
    const force = setTimeout(() => native.kill('SIGKILL'), 3000);
    await exit;
    clearTimeout(force);
  }
  if (page) await page.evaluate(() => window.probe?.pc.close()).catch(() => {});
  if (browser) await browser.close();
  lines?.close();
  key.fill(0);
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
