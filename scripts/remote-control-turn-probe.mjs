// Explicit development check: native signed ICE -> GStreamer -> real Chromium.
// Credentials arrive on stdin, never argv/env/output. No media lease is issued,
// so capture and OS input cannot start. Fixture signing keys are harness-only.
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../client-vue/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const python = process.env.REMOTE_CONTROL_PROBE_PYTHON;
if (!python) throw new Error('REMOTE_CONTROL_PROBE_PYTHON required');
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 16384) throw new Error('ICE_INPUT_LIMIT');
}
let input;
try {
  input = JSON.parse(raw);
} catch {
  throw new Error('INVALID_ICE_JSON');
}
raw = '';
if (
  !Array.isArray(input.iceServers) ||
  input.iceServers.length !== 1 ||
  !Array.isArray(input.iceServers[0].urls) ||
  input.iceServers[0].urls.length !== 1 ||
  !/^turns?:[a-zA-Z0-9.-]+:[0-9]{1,5}\?transport=(udp|tcp)$/.test(input.iceServers[0].urls[0])
)
  throw new Error('Use one TURN URL per relay check');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/remote-control-native-approval-v1.json'), 'utf8'),
);
const now = Date.now();
const key = { ...fixture.key, notBefore: now - 1000, notAfter: now + 600000 };
const privateKey = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
});
const signed = (body) => {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return {
    format: 'rc-signed-v1',
    keyId: key.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(`todesk-remote-control/v1\n${key.keyId}\n${payload}`),
      privateKey,
    ).toString('base64url'),
  };
};
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const approval = {
  ...fixture.approvalClaims,
  approvalId: randomUUID(),
  sessionId: randomUUID(),
  requestedScope: 'view',
  issuedAt: now,
  expiresAt: now + 45000,
  sessionExpiresAt: now + 60000,
};
const script = resolve(root, 'scripts/remote-control-host-engine.py');
let native,
  browser,
  heartbeat,
  lines,
  closed = false,
  failed = false;
let enginePid, nativeError, exitCode;
const events = [];
const evidence = {
  relay: true,
  transport: input.iceServers[0].urls[0].endsWith('=tcp') ? 'tcp' : 'udp',
  noCapture: true,
  noOsInput: true,
  testOnlyConsent: true,
};
const send = (value) => {
  if (!closed && native && !native.stdin.destroyed)
    native.stdin.write(`${JSON.stringify(value)}\n`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
const until = async (check, timeout = 22000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (nativeError) throw new Error('NATIVE_REJECTED');
    if (await check()) return;
    if (closed) throw new Error('NATIVE_EXITED');
    await sleep(20);
  }
  throw new Error('TURN_PROBE_TIMEOUT');
};
try {
  native = spawn(
    resolve(root, 'client-vue/src-tauri/target/debug/remote-control-host-harness'),
    [
      '--program',
      python,
      '--program-sha256',
      await digest(python),
      '--script',
      script,
      '--script-sha256',
      await digest(script),
      '--sidecar-arg',
      '--screen-source=/usr/bin/false',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  native.once('error', () => {
    nativeError = true;
  });
  native.stdin.on('error', () => {});
  // Consume diagnostics without copying potential third-party credential-bearing errors.
  native.stderr.on('data', () => {});
  native.once('close', (code) => {
    closed = true;
    exitCode = code;
  });
  lines = createInterface({ input: native.stdout });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'error') nativeError = true;
      events.push(event);
    } catch {
      nativeError = true;
    }
  });
  send({
    type: 'init',
    sessionId: approval.sessionId,
    keys: [key],
    approval: signed(approval),
    decision: 'view',
  });
  heartbeat = setInterval(() => send({ type: 'heartbeat' }), 500);
  await until(
    () =>
      events.some((e) => e.event === 'consent') &&
      events.some((e) => e.event === 'sidecar' && e.kind === 'ready'),
  );
  enginePid = events.find((e) => e.event === 'consent').enginePid;
  const configuration = {
    iceServers: input.iceServers,
    iceTransportPolicy: 'relay',
    expiresAt: now + 359000,
  };
  send({
    type: 'configure-ice',
    proof: signed({
      protocolVersion: 1,
      issuer: 'todesk-remote-control',
      audience: 'todesk-native-ice',
      purpose: 'ice-config',
      sessionId: approval.sessionId,
      host: approval.host,
      controller: approval.controller,
      issuedAt: now,
      sessionExpiresAt: approval.sessionExpiresAt,
      ...configuration,
    }),
  });
  await until(() => events.some((e) => e.event === 'sidecar' && e.kind === 'network-configured'));
  evidence.nativeConfigured = true;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const negotiationId = randomUUID();
  await page.exposeFunction('sendOffer', (sdp) => send({ type: 'offer', sdp, negotiationId }));
  await page.exposeFunction('sendCandidate', (candidate) =>
    send({ type: 'ice', candidate: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex }),
  );
  await page.evaluate(async (configuration) => {
    const pc = (window.probePeer = new RTCPeerConnection({
      iceServers: configuration.iceServers,
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
    }));
    window.probeChannels = ['rc-state-v1', 'rc-input-v1'].map((label) =>
      pc.createDataChannel(label, { ordered: true }),
    );
    const video = pc.addTransceiver('video', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter(
      (codec) =>
        codec.mimeType === 'video/H264' &&
        codec.sdpFmtpLine?.includes('profile-level-id=42e01f') &&
        codec.sdpFmtpLine?.includes('packetization-mode=1'),
    );
    if (!codecs.length) throw new Error('H264_REQUIRED');
    video.setCodecPreferences(codecs);
    const candidates = [];
    let sent = false;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        if (sent) void window.sendCandidate(candidate.toJSON());
        else candidates.push(candidate.toJSON());
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await window.sendOffer(pc.localDescription.sdp);
    sent = true;
    for (const candidate of candidates) await window.sendCandidate(candidate);
  }, configuration);
  const remoteCandidates = [];
  let answer = false,
    dtls = false;
  const channels = new Set();
  await until(async () => {
    for (const e of events.splice(0)) {
      if (e.event !== 'sidecar') continue;
      if (e.kind === 'media-started') throw new Error('UNAUTHORIZED_MEDIA');
      if (e.kind === 'answer') {
        await page.evaluate(
          (sdp) => window.probePeer.setRemoteDescription({ type: 'answer', sdp }),
          e.payload.sdp,
        );
        answer = true;
      }
      if (e.kind === 'ice') {
        if (e.payload.candidate.split(/\s+/)[7] !== 'relay')
          throw new Error('NON_RELAY_NATIVE_CANDIDATE');
        remoteCandidates.push(e.payload);
      }
      if (e.kind === 'dtls') dtls = true;
      if (e.kind === 'channel-open') channels.add(e.payload.label);
      if (e.kind === 'error' || e.kind === 'stopped') throw new Error('ENGINE_STOPPED');
    }
    if (answer)
      for (const candidate of remoteCandidates.splice(0))
        await page.evaluate((c) => window.probePeer.addIceCandidate(c), candidate);
    return (
      dtls &&
      channels.size === 2 &&
      page.evaluate(() => window.probeChannels.every((c) => c.readyState === 'open'))
    );
  });
  evidence.selectedPair = await page.evaluate(async () => {
    const stats = await window.probePeer.getStats();
    const transport = [...stats.values()].find(
      (s) => s.type === 'transport' && s.selectedCandidatePairId,
    );
    const pair = stats.get(transport?.selectedCandidatePairId);
    const local = stats.get(pair?.localCandidateId),
      remote = stats.get(pair?.remoteCandidateId);
    return {
      state: pair?.state,
      localType: local?.candidateType,
      remoteType: remote?.candidateType,
      relayProtocol: local?.relayProtocol,
    };
  });
  if (
    evidence.selectedPair.state !== 'succeeded' ||
    evidence.selectedPair.localType !== 'relay' ||
    evidence.selectedPair.remoteType !== 'relay'
  )
    throw new Error('RELAY_NOT_SELECTED');
  evidence.dtls = dtls;
  evidence.channels = channels.size;
} catch (error) {
  failed = true;
  // Error objects may contain ICE URLs/credentials. Output only our allowlisted codes.
  evidence.error = [
    'NATIVE_REJECTED',
    'NATIVE_EXITED',
    'TURN_PROBE_TIMEOUT',
    'UNAUTHORIZED_MEDIA',
    'NON_RELAY_NATIVE_CANDIDATE',
    'ENGINE_STOPPED',
    'RELAY_NOT_SELECTED',
  ].includes(error.message)
    ? error.message
    : 'TURN_PROBE_FAILED';
} finally {
  clearInterval(heartbeat);
  send({ type: 'stop' });
  await browser?.close();
  const end = Date.now() + 3000;
  while (native && !closed && Date.now() < end) await sleep(20);
  if (native && !closed) {
    native.kill('SIGKILL');
    await sleep(250);
  }
  lines?.close();
  const stopped = events.find((e) => e.event === 'sidecar' && e.kind === 'stopped')?.payload;
  evidence.captureNeverStarted =
    !!stopped && stopped.frames === 0 && stopped.bytes === 0 && stopped.screenPid === null;
  evidence.nativeExited = closed;
  evidence.exitCode = exitCode;
  evidence.engineExited = !enginePid || !alive(enginePid);
  if (
    !evidence.nativeExited ||
    !evidence.engineExited ||
    (!failed && (!evidence.captureNeverStarted || nativeError || exitCode !== 0))
  )
    failed = true;
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = failed ? 1 : 0;
}
