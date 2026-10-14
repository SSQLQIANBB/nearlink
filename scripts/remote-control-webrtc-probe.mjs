// Test-only browser/native interoperability. Screen capture requires explicit
// --source=screen. The data channel only echoes a constant; never injects input.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(new URL('../client-vue/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const python = process.env.REMOTE_CONTROL_PROBE_PYTHON;
if (!python) throw new Error('Set REMOTE_CONTROL_PROBE_PYTHON to a temporary SDK Python path');
const source =
  process.argv.find((value) => value.startsWith('--source='))?.slice('--source='.length) ??
  'synthetic';
if (!['synthetic', 'screen'].includes(source))
  throw new Error('Source must be synthetic or screen');
const closePipe = process.argv.includes('--stop-mode=pipe-close');
const workingDirectory = await mkdtemp(join(tmpdir(), 'todesk-screen-webrtc-'));
const nativeArgs = [
  fileURLToPath(new URL('./remote-control-gstreamer-probe.py', import.meta.url)),
  '--source',
  source,
];
if (source === 'screen') {
  const executable = join(workingDirectory, 'screen-source');
  try {
    await promisify(execFile)(
      'xcrun',
      [
        'swiftc',
        '-parse-as-library',
        fileURLToPath(new URL('./remote-control-screen-source.swift', import.meta.url)),
        '-o',
        executable,
      ],
      { timeout: 60000 },
    );
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }
  nativeArgs.push('--screen-source', executable);
}
const native = spawn(python, nativeArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = createInterface({ input: native.stdout });
let nativeExited = false;
let nativeExitCode;
const exited = new Promise((resolve) =>
  native.once('close', (code) => {
    nativeExited = true;
    nativeExitCode = code;
    resolve();
  }),
);
let page;
let nativeVersion;
let nativeFailure;
let stopResult;
let closing = false;
let stderr = '';
const signals = [];
native.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-4000);
});
native.on('error', (error) => {
  nativeFailure = error;
});
native.stdin.on('error', (error) => {
  if (!closing) nativeFailure = error;
});
let readyTimeout;
const ready = new Promise((resolve, reject) => {
  readyTimeout = setTimeout(() => reject(new Error('Native SDK startup timed out')), 30000);
  native.once('exit', (code) => {
    if (code) reject(new Error(`Native exited with ${code}: ${stderr}`));
  });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'ready') {
      clearTimeout(readyTimeout);
      nativeVersion = message.version;
      resolve();
    } else if (message.type === 'stopped') {
      stopResult = message;
    } else if (message.type === 'error' && !closing) {
      nativeFailure = new Error(`${message.message} ${message.debug ?? ''} ${stderr}`);
      reject(nativeFailure);
    } else {
      signals.push(message);
    }
  });
});
const send = (message) => {
  if (!nativeExited && !native.stdin.destroyed) native.stdin.write(`${JSON.stringify(message)}\n`);
};
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 500);
let browser;
let result;
let browserVersion;
let runFailure;
let shutdownVerification;
try {
  await ready;
  browser = await chromium.launch({
    headless: true,
    args: ['--allow-loopback-in-peer-connection'],
  });
  page = await browser.newPage();
  await page.exposeFunction('sendNativeSignal', send);
  await page.setContent('<video id="remote" autoplay muted playsinline></video>');
  await page.evaluate(async (source) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const video = document.querySelector('video');
    window.probe = {
      pc,
      frames: 0,
      dataAck: false,
      pendingIce: [],
      startedAt: performance.now(),
      firstFrameMs: null,
    };
    const onFrame = () => {
      window.probe.frames++;
      window.probe.firstFrameMs ??= Math.round(performance.now() - window.probe.startedAt);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    pc.ontrack = (event) => {
      video.srcObject = new MediaStream([event.track]);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) window.sendNativeSignal({ type: 'ice', ...candidate.toJSON() });
    };
    const channel = pc.createDataChannel('rc-probe-v1', { ordered: true });
    channel.onopen = () => channel.send('native-probe-v1');
    channel.onmessage = ({ data }) => {
      window.probe.dataAck = data === 'native-probe-ack-v1';
    };
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    const mimeType = source === 'screen' ? 'video/H264' : 'video/VP8';
    const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter(
      (c) => c.mimeType === mimeType,
    );
    if (codecs.length === 0) throw new Error(`Browser lacks ${mimeType} decoder`);
    transceiver.setCodecPreferences(codecs);
    await pc.setLocalDescription(await pc.createOffer());
    await window.sendNativeSignal({ type: 'offer', sdp: pc.localDescription.sdp });
  }, source);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (nativeFailure) throw nativeFailure;
    while (signals.length) {
      await page.evaluate(async (message) => {
        const { pc, pendingIce } = window.probe;
        if (message.type === 'answer') {
          await pc.setRemoteDescription(message);
          for (const ice of pendingIce.splice(0)) await pc.addIceCandidate(ice);
        } else if (message.type === 'ice') {
          const ice = { candidate: message.candidate, sdpMLineIndex: message.sdpMLineIndex };
          if (pc.remoteDescription) await pc.addIceCandidate(ice);
          else pendingIce.push(ice);
        }
      }, signals.shift());
    }
    result = await page.evaluate(async () => {
      const { pc, frames, dataAck, firstFrameMs } = window.probe;
      const stats = await pc.getStats();
      const inbound = [...stats.values()].find(
        (s) => s.type === 'inbound-rtp' && s.kind === 'video',
      );
      const codec = inbound ? stats.get(inbound.codecId) : null;
      return {
        connectionState: pc.connectionState,
        framesPresented: frames,
        dataAck,
        firstFrameMs,
        framesDecoded: inbound?.framesDecoded ?? 0,
        codec: codec?.mimeType ?? null,
        width: inbound?.frameWidth ?? null,
        height: inbound?.frameHeight ?? null,
        totalDecodeTime: inbound?.totalDecodeTime ?? null,
        codecFmtp: codec?.sdpFmtpLine ?? null,
      };
    });
    const requiredFrames = source === 'screen' ? 30 : 5;
    if (
      result.framesPresented >= requiredFrames &&
      result.framesDecoded >= requiredFrames &&
      result.dataAck
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(result.framesPresented >= (source === 'screen' ? 30 : 5) && result.dataAck))
    throw new Error(`Incomplete media probe: ${JSON.stringify(result)} ${stderr}`);
  browserVersion = browser.version();
} catch (error) {
  runFailure = error;
} finally {
  closing = true;
  clearInterval(heartbeat);
  clearTimeout(readyTimeout);
  if (!nativeExited) {
    if (!closePipe) send({ type: 'stop' });
    native.stdin.end();
    const terminate = setTimeout(() => native.kill('SIGTERM'), 5000);
    const forceKill = setTimeout(() => native.kill('SIGKILL'), 7000);
    await exited;
    clearTimeout(terminate);
    clearTimeout(forceKill);
  }
  if (page && result?.framesPresented) {
    // Drain any already received decoder frames, then verify no ongoing media
    // survives the native stop. The last displayed image may remain visible.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await page.evaluate(() => window.probe.frames);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await page.evaluate(() => window.probe.frames);
    let childExited = true;
    if (stopResult?.screenPid) {
      try {
        process.kill(stopResult.screenPid, 0);
        childExited = false;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    shutdownVerification = {
      framesStableAfterStop: before === after,
      framesAfterStop: after,
      childExited,
    };
  }
  if (page) await page.evaluate(() => window.probe?.pc.close()).catch(() => {});
  if (browser) await browser.close();
  lines.close();
  await rm(workingDirectory, { recursive: true, force: true });
}
if (runFailure) {
  runFailure.message += ` Shutdown: ${JSON.stringify(stopResult)}`;
  throw runFailure;
}
if (nativeExitCode !== 0)
  throw new Error(`Native peer exited abnormally: ${nativeExitCode} ${stderr}`);
if (
  source === 'screen' &&
  !(stopResult?.screenStats?.captureStopped && stopResult.screenExitCode === 0)
) {
  throw new Error(`Screen shutdown did not complete: ${JSON.stringify(stopResult)} ${stderr}`);
}
if (!shutdownVerification?.framesStableAfterStop || !shutdownVerification.childExited) {
  throw new Error(`Media or screen child survived stop: ${JSON.stringify(shutdownVerification)}`);
}
console.log(
  JSON.stringify({
    status: 'passed',
    nativeVersion,
    browserVersion,
    source,
    stopMode: closePipe ? 'pipe-close' : 'stop',
    ...result,
    shutdown: stopResult,
    shutdownVerification,
  }),
);
