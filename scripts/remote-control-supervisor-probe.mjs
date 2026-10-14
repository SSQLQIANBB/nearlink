// Explicit development harness: signed test consent, real native screen media,
// actual browser RemoteControlPeer, recording-only input. Never packaged.
import { spawn, execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../client-vue/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const { createServer } = await import(require.resolve('vite'));
const python = process.env.REMOTE_CONTROL_PROBE_PYTHON;
const bundleArgument = process.argv
  .find((value) => value.startsWith('--engine-bundle='))
  ?.slice('--engine-bundle='.length);
const engineBundle = bundleArgument ? resolve(bundleArgument) : null;
if ((!python && !engineBundle) || !process.argv.includes('--source=screen'))
  throw new Error('Requires a test Python or --engine-bundle, and explicit --source=screen');
const mode =
  process.argv.find((value) => value.startsWith('--stop-mode='))?.split('=')[1] || 'stop';
if (
  ![
    'stop',
    'lease-expiry',
    'parent-kill',
    'stdin-eof',
    'pause',
    'capture-freeze',
    'capture-recover',
    'encode-freeze',
    'forward-freeze',
    'render-freeze',
    'layout-change',
  ].includes(mode)
)
  throw new Error('Invalid stop mode');
const freezeMode = [
  'capture-freeze',
  'capture-recover',
  'encode-freeze',
  'forward-freeze',
  'render-freeze',
].includes(mode);
const sourceFault = [
  'capture-freeze',
  'capture-recover',
  'encode-freeze',
  'layout-change',
].includes(mode);
const layoutMode =
  process.argv.find((value) => value.startsWith('--layout='))?.split('=')[1] || 'default';
if (!['default', 'letterbox'].includes(layoutMode)) throw new Error('Invalid test layout');
const scope = process.argv.find((value) => value.startsWith('--scope='))?.split('=')[1] || 'view';
if (!['view', 'control'].includes(scope)) throw new Error('Invalid test scope');
const browserMode =
  process.argv.find((value) => value.startsWith('--browser='))?.split('=')[1] || 'chromium';
if (!['chromium', 'wkwebview'].includes(browserMode)) throw new Error('Invalid test browser');
if (engineBundle && (freezeMode || sourceFault || layoutMode !== 'default'))
  throw new Error('Packaged engines cannot accept test source overrides');
const binary = resolve(root, 'client-vue/src-tauri/target/debug/remote-control-host-harness');
const script = resolve(root, 'scripts/remote-control-host-engine.py');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/remote-control-native-approval-v1.json'), 'utf8'),
);
const privateKey = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
});
const key = { ...fixture.key, notBefore: Date.now() - 1000, notAfter: Date.now() + 120000 };
const signed = (claims) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = await mkdtemp(join(tmpdir(), 'todesk-supervisor-'));
let vite, native, lines, browser, page, heartbeat;
let nativeClosed = false,
  nativeExit,
  failure,
  stderr = '';
const events = [];
const evidence = { mode, scope, layoutMode, browserMode, noOsInput: true, testOnlyConsent: true };
let closing = false;
let sourcePid, enginePid;
let sourcePath;
const send = (value) => {
  if (native && !nativeClosed && !native.stdin.destroyed)
    native.stdin.write(`${JSON.stringify(value)}\n`);
};
const exists = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
try {
  // Vite's PostCSS/Tailwind config resolves content relative to the app root.
  process.chdir(resolve(root, 'client-vue'));
  sourcePath = join(dir, 'screen-source');
  if (engineBundle) {
    const validation = await promisify(execFile)(
      'python3',
      [resolve(root, 'scripts/verify-remote-control-engine.py'), engineBundle, '--static-only'],
      { timeout: 60000 },
    );
    evidence.bundle = JSON.parse(validation.stdout);
  } else {
    await promisify(execFile)(
      'xcrun',
      [
        'swiftc',
        '-parse-as-library',
        ...(sourceFault || layoutMode === 'letterbox' ? ['-D', 'REMOTE_CONTROL_TEST_FAULTS'] : []),
        resolve(root, 'scripts/remote-control-screen-source.swift'),
        '-o',
        sourcePath,
      ],
      { timeout: 60000 },
    );
  }
  vite = await createServer({
    root: resolve(root, 'client-vue'),
    configFile: resolve(root, 'client-vue/vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 4197, strictPort: true },
  });
  await vite.listen();
  const engineArgs = ['--screen-source', sourcePath];
  if (sourceFault || layoutMode === 'letterbox') {
    engineArgs.push('--test-source-faults');
    const sourceArgs = sourceFault
      ? [
          '--test-freeze-stage',
          mode === 'layout-change' ? 'layout' : mode === 'encode-freeze' ? 'encode' : 'capture',
          '--test-freeze-after-ms',
          '2500',
        ]
      : [];
    if (mode === 'capture-recover') sourceArgs.push('--test-freeze-duration-ms', '4500');
    if (layoutMode === 'letterbox') sourceArgs.push('--test-letterbox');
    for (const value of sourceArgs) engineArgs.push(`--source-arg=${value}`);
  }
  if (mode === 'forward-freeze')
    engineArgs.push('--test-source-faults', '--test-forward-freeze-after-ms', '2500');
  const program = engineBundle ? join(engineBundle, 'bin/remote-control-engine') : python;
  native = spawn(
    binary,
    [
      '--program',
      program,
      '--program-sha256',
      await digest(program),
      ...(engineBundle
        ? []
        : [
            '--script',
            script,
            '--script-sha256',
            await digest(script),
            ...engineArgs.flatMap((value) => ['--sidecar-arg', value]),
          ]),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  native.on('error', (error) => {
    failure = error;
  });
  native.stdin.on('error', (error) => {
    if (!closing && mode !== 'parent-kill') failure = error;
  });
  native.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  native.once('close', (code) => {
    nativeClosed = true;
    nativeExit = code;
  });
  lines = createInterface({ input: native.stdout });
  lines.on('line', (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      failure = new Error('Invalid native JSON');
    }
  });
  const until = async (predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const rejected = events.find((value) => value.event === 'error');
      if (rejected) throw new Error(`Native rejected: ${rejected.code || rejected.message}`);
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error(
      `Supervisor timeout; events=${JSON.stringify(events).slice(-3000)} stderr=${stderr}`,
    );
  };
  const waitEvent = async (event) => {
    let found;
    await until(() => {
      const index = events.findIndex((value) => value.event === event);
      if (index >= 0) found = events.splice(index, 1)[0];
      return !!found;
    });
    return found;
  };
  const now = Date.now();
  const approvalClaims = {
    ...fixture.approvalClaims,
    approvalId: randomUUID(),
    sessionId: randomUUID(),
    requestedScope: scope,
    issuedAt: now,
    expiresAt: now + 45000,
    sessionExpiresAt: now + 60000,
  };
  send({
    type: 'init',
    sessionId: approvalClaims.sessionId,
    keys: [key],
    approval: signed(approvalClaims),
    decision: scope,
  });
  const approved = await waitEvent('consent');
  enginePid = approved.enginePid;
  if (!Number.isSafeInteger(enginePid) || enginePid <= 0)
    throw new Error('Missing native engine process identity');
  const consent =
    approved.payload || JSON.parse(Buffer.from(approved.envelope.payload, 'base64url').toString());
  const binding = {
    sessionId: approvalClaims.sessionId,
    host: approvalClaims.host,
    controller: approvalClaims.controller,
    negotiationId: randomUUID(),
    consentNonce: consent.consentNonce,
    screenId: 'primary',
  };
  browser =
    browserMode === 'wkwebview'
      ? await (await import('./remote-control-wkwebview.mjs')).createWkBrowser(dir)
      : await chromium.launch({
          headless: true,
          args: [
            '--allow-loopback-in-peer-connection',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        });
  page = await browser.newPage();
  await page.goto('http://127.0.0.1:4197/login');
  await page.exposeFunction('sendHostSignal', (signal) => {
    if (signal.type === 'offer') {
      evidence.offeredVideo = signal.sdp
        .split(/\r?\n/)
        .filter((line) => /^m=video|^a=rtpmap:.*(?:H264|VP8)|^a=fmtp:/.test(line));
      const sdp = signal.sdp
        .split('\r\n')
        .filter(
          (line) =>
            !line.startsWith('a=candidate:') ||
            / (127\.0\.0\.1|::1) \d+ typ host(?: |$)/.test(line),
        )
        .join('\r\n');
      send({ type: 'offer', sdp, negotiationId: binding.negotiationId });
    } else if (/ (127\.0\.0\.1|::1) \d+ typ host(?: |$)/.test(signal.candidate.candidate)) {
      evidence.loopbackCandidates = (evidence.loopbackCandidates || 0) + 1;
      send({ type: 'ice', ...signal.candidate });
    } else evidence.filteredCandidates = (evidence.filteredCandidates || 0) + 1;
  });
  await page.evaluate(
    async ({ binding, key }) => {
      const { RemoteControlPeer } = await import('/src/services/remoteControlPeer.ts');
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.tabIndex = 0;
      video.style.cssText = 'position:fixed;inset:0;width:640px;height:360px;z-index:99999';
      document.body.append(video);
      window.supervisorProbe = {
        ready: false,
        armed: false,
        acks: [],
        states: [],
        published: 0,
        ended: null,
        frames: 0,
        firstFrameMs: null,
        leaseAt: null,
        video,
        pauses: [],
      };
      const p = window.supervisorProbe;
      const frame = () => {
        p.frames++;
        if (p.leaseAt !== null && p.firstFrameMs === null)
          p.firstFrameMs = Math.round(performance.now() - p.leaseAt);
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      p.peer = new RemoteControlPeer({
        binding,
        keys: [key],
        iceServers: [],
        iceTransportPolicy: 'all',
        onSignal: window.sendHostSignal,
        onReady: () => {
          p.ready = true;
        },
        onStats: (value) => {
          p.lastStats = value;
        },
        onInputArmed: (armed) => {
          p.armed = armed;
        },
        onStream: (stream) => {
          if (stream) p.published++;
        },
        onPauseInput: (reason) => p.pauses.push(reason),
        onEnd: (reason) => {
          p.ended = reason;
        },
      });
      p.peer.stateChannel.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === 'input-ack') p.acks.push(message.payload.seq);
        if (message.type === 'input-window') p.lastWindow = message.payload;
        if (message.type === 'layout') p.layout = message.payload;
        if (message.type === 'pause' || message.type === 'end')
          p.states.push({ type: message.type, payload: message.payload, at: performance.now() });
      });
      p.peer.attachVideo(video);
      p.inspectTimer = setInterval(async () => {
        if (p.ended) return;
        const stats = await p.peer.peer.getStats();
        p.lastMediaInspection = {
          width: video.videoWidth,
          height: video.videoHeight,
          paused: video.paused,
          readyState: video.readyState,
          frames: p.frames,
          playbackFrames: video.getVideoPlaybackQuality?.().totalVideoFrames,
          srcObject: !!video.srcObject,
          tracks: video.srcObject?.getTracks().map((track) => ({
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          })),
          received: [...stats.values()]
            .filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')
            .map((s) => ({
              bytesReceived: s.bytesReceived,
              framesDecoded: s.framesDecoded,
              framesReceived: s.framesReceived,
              keyFramesDecoded: s.keyFramesDecoded,
            })),
        };
      }, 1000);
      await p.peer.start();
    },
    { binding, key },
  );
  let dtls,
    challenge,
    endedEvent,
    leaseSent = false,
    connectionSent = false,
    leaseAt = null;
  let nextRenewAt = Infinity,
    renewPending = false,
    latestProgress,
    nativeHealth,
    sourceLayout;
  let faultStartAt = null,
    faultEndAt = null,
    faultProgress,
    nativePausedAt = null,
    resumedAt = null;
  evidence.leasesInstalled = 0;
  const healthHistory = [];
  heartbeat = setInterval(() => send({ type: 'heartbeat' }), 500);
  const pump = async () => {
    for (const event of events.splice(0)) {
      if (event.event === 'error')
        throw new Error(`Native rejected: ${event.code || event.message}`);
      if (event.event === 'challenge') challenge = event;
      if (event.event === 'stopped' || event.event === 'ended') endedEvent = event;
      if (event.event === 'media-health') {
        nativeHealth = event.state || event.status;
        healthHistory.push({
          state: nativeHealth,
          atMs: leaseAt === null ? null : Date.now() - leaseAt,
          stage: event.stage,
        });
        if (nativeHealth === 'stalled' && nativePausedAt === null) nativePausedAt = Date.now();
        if (nativePausedAt !== null && nativeHealth === 'healthy' && resumedAt === null)
          resumedAt = Date.now();
      }
      if (event.event === 'sidecar') {
        const { kind, payload } = event;
        if (kind === 'answer')
          evidence.answeredVideo = payload.sdp
            .split(/\r?\n/)
            .filter((line) =>
              /^m=video|^a=rtpmap:.*H264|^a=fmtp:|^a=(sendonly|recvonly|inactive|sendrecv)$/.test(
                line,
              ),
            );
        if (kind === 'ready') enginePid = payload.pid || enginePid;
        if (kind === 'dtls') dtls = payload;
        if (kind === 'media-started') {
          sourcePid = payload.screenPid || payload.pid;
          evidence.mediaStarted = true;
        }
        if (kind === 'media-progress') {
          latestProgress = payload;
          evidence.lastMediaProgress = payload;
        }
        if (kind === 'media-layout') sourceLayout = payload;
        if (kind === 'test-fault') {
          if (payload.phase === 'begin') {
            faultStartAt = Date.now();
            faultProgress = latestProgress;
          }
          if (payload.phase === 'end') faultEndAt = Date.now();
        }
        if (kind === 'stopped') {
          evidence.engineStopped = payload;
          sourcePid ||= payload.screenPid;
        }
        if (kind === 'error') {
          if (mode === 'layout-change' && payload.reason === 'MEDIA_LAYOUT_CHANGED')
            evidence.layoutChangeError = payload.reason;
          else throw new Error(`Engine rejected: ${JSON.stringify(payload)}`);
        }
        if (kind === 'answer' || kind === 'ice')
          await page.evaluate(
            async ({ kind, payload, binding }) => {
              const signal =
                kind === 'answer'
                  ? { type: 'answer', sdp: payload.sdp }
                  : { type: 'candidate', candidate: payload };
              await window.supervisorProbe.peer.receiveSignal({
                ...signal,
                negotiationId: binding.negotiationId,
                connectionGeneration: binding.host.generation,
              });
            },
            { kind, payload, binding },
          );
      }
    }
    if (dtls && !connectionSent) {
      const before = await page.evaluate(() => ({
        frames: window.supervisorProbe.frames,
        published: window.supervisorProbe.published,
      }));
      if (before.frames || before.published || evidence.mediaStarted)
        throw new Error('Media before authorization');
      evidence.beforeAuthorization = before;
      Object.assign(binding, dtls);
      const issuedAt = Date.now();
      const connection = signed({
        ...binding,
        protocolVersion: 1,
        issuer: 'todesk-remote-control',
        audience: 'todesk-remote-peer',
        purpose: 'connection',
        scope,
        authorizationRevision: 1,
        controlEpoch: 1,
        issuedAt,
        expiresAt: issuedAt + 30000,
      });
      // Native must verify the connection before receiving the browser hello.
      send({ type: 'connection', envelope: connection });
      await page.evaluate(
        (envelope) => window.supervisorProbe.peer.installConnectionProof(envelope),
        connection,
      );
      connectionSent = true;
    }
    if (
      challenge &&
      !endedEvent &&
      !nativeClosed &&
      (await page.evaluate(() => window.supervisorProbe.ready && !window.supervisorProbe.ended))
    ) {
      const issuedAt = Date.now();
      const lease = signed({
        ...binding,
        protocolVersion: 1,
        issuer: 'todesk-remote-control',
        audience: 'todesk-remote-peer',
        purpose: 'lease',
        scope,
        authorizationRevision: 1,
        controlEpoch: 1,
        issuedAt,
        expiresAt: issuedAt + (freezeMode ? 15000 : 7000),
        leaseSeq: challenge.leaseSeq,
        challenge: challenge.challenge,
      });
      await page.evaluate(async (envelope) => {
        const p = window.supervisorProbe;
        p.leaseAt ??= performance.now();
        await p.peer.installMediaLease(envelope);
      }, lease);
      send({ type: 'lease', envelope: lease });
      leaseSent = true;
      leaseAt ??= Date.now();
      challenge = null;
      renewPending = false;
      nextRenewAt = Date.now() + 4000;
      evidence.leasesInstalled++;
    }
    if (
      freezeMode &&
      leaseSent &&
      !renewPending &&
      !nativeClosed &&
      !endedEvent &&
      Date.now() >= nextRenewAt &&
      (await page.evaluate(() => !window.supervisorProbe.ended))
    ) {
      renewPending = true;
      send({ type: 'challenge' });
    }
  };
  await until(async () => {
    await pump();
    const state = await page.evaluate(() => ({
      frames: window.supervisorProbe.frames,
      ended: window.supervisorProbe.ended,
    }));
    if (state.ended) throw new Error(`Browser ended early: ${state.ended}`);
    return state.frames >= 10;
  }, 30000);
  evidence.media = await page.evaluate(async () => {
    const p = window.supervisorProbe,
      stats = await p.peer.peer.getStats();
    const inbound = [...stats.values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
    return {
      ready: p.ready,
      frames: p.frames,
      firstFrameMs: p.firstFrameMs,
      width: inbound?.frameWidth,
      height: inbound?.frameHeight,
      codec: stats.get(inbound?.codecId)?.mimeType,
      initiallyArmed: p.armed,
    };
  });
  if (!Number.isSafeInteger(sourcePid) || sourcePid <= 0)
    throw new Error('Missing screen source process identity');
  if (
    evidence.media.initiallyArmed ||
    evidence.media.width !== 1280 ||
    evidence.media.height !== 720
  )
    throw new Error('Unexpected authorized media result');
  await until(async () => {
    await pump();
    return !!sourceLayout && page.evaluate(() => !!window.supervisorProbe.layout);
  }, 3000);
  evidence.layout = await page.evaluate(() => window.supervisorProbe.layout);
  if (!isDeepStrictEqual(sourceLayout, evidence.layout))
    throw new Error('Native layout differs from authenticated source geometry');
  evidence.pointerMapping = await page.evaluate(() => {
    const p = window.supervisorProbe;
    // Exercise CSS letterboxing separately from padding in actual encoded pixels.
    p.video.style.width = '640px';
    p.video.style.height = '500px';
    const surface = p.video.getBoundingClientRect();
    const { encodedSize, contentRect } = p.layout.geometry;
    const scale = Math.min(surface.width / encodedSize.width, surface.height / encodedSize.height);
    const frameLeft = surface.left + (surface.width - encodedSize.width * scale) / 2;
    const frameTop = surface.top + (surface.height - encodedSize.height * scale) / 2;
    const at = (x, y) => p.peer.mapPointer(frameLeft + x * scale, frameTop + y * scale);
    const cases = [
      [contentRect.x, contentRect.y, { x: 0, y: 0 }],
      [
        contentRect.x + contentRect.width / 2,
        contentRect.y + contentRect.height / 2,
        { x: 0.5, y: 0.5 },
      ],
      [contentRect.x + contentRect.width, contentRect.y + contentRect.height, { x: 1, y: 1 }],
    ];
    for (const [x, y, expected] of cases) {
      const actual = at(x, y);
      if (
        !actual ||
        Math.abs(actual.x - expected.x) > 1e-9 ||
        Math.abs(actual.y - expected.y) > 1e-9
      )
        throw new Error('Actual video content mapping mismatch');
    }
    if (p.peer.mapPointer(surface.left + surface.width / 2, surface.top + 1) !== null)
      throw new Error('CSS letterbox accepted a pointer');
    let innerBarsRejected = 0;
    if (contentRect.x > 1) {
      if (at(contentRect.x / 2, contentRect.y + contentRect.height / 2) !== null)
        throw new Error('Encoded left padding accepted');
      innerBarsRejected++;
    }
    if (contentRect.y > 1) {
      if (at(contentRect.x + contentRect.width / 2, contentRect.y / 2) !== null)
        throw new Error('Encoded top padding accepted');
      innerBarsRejected++;
    }
    const right = contentRect.x + contentRect.width,
      bottom = contentRect.y + contentRect.height;
    if (encodedSize.width - right > 1) {
      if (at((right + encodedSize.width) / 2, contentRect.y + contentRect.height / 2) !== null)
        throw new Error('Encoded right padding accepted');
      innerBarsRejected++;
    }
    if (encodedSize.height - bottom > 1) {
      if (at(contentRect.x + contentRect.width / 2, (bottom + encodedSize.height) / 2) !== null)
        throw new Error('Encoded bottom padding accepted');
      innerBarsRejected++;
    }
    p.mappedCenter = at(
      contentRect.x + contentRect.width / 2,
      contentRect.y + contentRect.height / 2,
    );
    return {
      cornersAndCenter: true,
      cssLetterboxRejected: true,
      innerBarsRejected,
      decodedSizeMatches:
        p.video.videoWidth === encodedSize.width && p.video.videoHeight === encodedSize.height,
    };
  });
  if (
    !evidence.pointerMapping.decodedSizeMatches ||
    (layoutMode === 'letterbox' && evidence.pointerMapping.innerBarsRejected !== 4)
  )
    throw new Error('Requested geometry checks not proven');
  if (scope === 'control') {
    await page.bringToFront();
    await until(() => page.evaluate(() => !document.hidden), 2000);
  }
  const armRequested = await page.evaluate(() => {
    const p = window.supervisorProbe;
    p.video.focus();
    return p.peer.requestInputArm();
  });
  evidence.armRequested = armRequested;
  if (!armRequested)
    evidence.armContext = await page.evaluate(() => {
      const p = window.supervisorProbe;
      return {
        hidden: document.hidden,
        focused: document.activeElement === p.video,
        frameCount: p.peer.frameCount,
        frozen: p.peer.frozen,
        hostPaused: p.peer.hostPaused,
        lastFrameAge: performance.now() - p.peer.lastFrame,
      };
    });
  if (scope === 'view' && armRequested) throw new Error('View lease allowed input');
  if (scope === 'control') {
    if (!armRequested) throw new Error('Explicit arm rejected');
    await until(async () => {
      await pump();
      return page.evaluate(() => window.supervisorProbe.armed);
    }, 3000);
    const queued = await page.evaluate(() => {
      const p = window.supervisorProbe;
      return [
        p.peer.sendInput({ type: 'button', payload: { ...p.mappedCenter, button: 0, down: true } }),
        p.peer.sendInput({
          type: 'button',
          payload: { ...p.mappedCenter, button: 0, down: false },
        }),
        p.peer.sendInput({
          type: 'text',
          payload: { text: '记录型输入测试🙂', commitId: crypto.randomUUID() },
        }),
      ];
    });
    if (!queued.every(Boolean)) throw new Error('Recording input rejected');
    await until(async () => {
      await pump();
      return page.evaluate(() => window.supervisorProbe.acks.length === 3);
    }, 3000);
    evidence.nativeInputAcks = await page.evaluate(() => window.supervisorProbe.acks);
    if (evidence.nativeInputAcks.join(',') !== '1,2,3')
      throw new Error('Native input ACK sequence mismatch');
  }
  if (mode === 'pause') {
    send({ type: 'pause' });
    const before = await page.evaluate(() => window.supervisorProbe.frames);
    await until(async () => {
      await pump();
      return (await page.evaluate(() => window.supervisorProbe.frames)) > before + 3;
    });
    evidence.viewSurvivesPause = true;
    evidence.oldControlCannotArm = await page.evaluate(() => {
      const p = window.supervisorProbe;
      return !p.armed && !p.peer.requestInputArm();
    });
    if (!evidence.oldControlCannotArm) throw new Error('Paused control epoch resumed');
  }
  if (freezeMode) {
    if (['encode-freeze', 'forward-freeze', 'render-freeze'].includes(mode)) {
      // Fault injection in the test controller only: disable its local video
      // watchdog while preserving honest frame-count heartbeats. The native
      // supervisor must enforce both deadlines without help from that watchdog.
      await page.evaluate((binding) => {
        const p = window.supervisorProbe;
        clearInterval(p.peer.timer);
        p.peer.timer = null;
        p.testHeartbeat = setInterval(() => {
          if (p.peer.stateChannel.readyState === 'open')
            p.peer.stateChannel.send(
              JSON.stringify({
                version: 1,
                sessionId: binding.sessionId,
                negotiationId: binding.negotiationId,
                connectionGeneration: binding.controller.generation,
                type: 'heartbeat',
                payload: { renderedFrames: p.peer.frameCount },
              }),
            );
        }, 250);
      }, binding);
      evidence.controllerVideoWatchdogDisabledForTest = true;
    }
    if (mode === 'render-freeze') {
      faultStartAt = Date.now();
      faultProgress = latestProgress;
      await page.evaluate(() => window.supervisorProbe.video.pause());
    }
    await until(async () => {
      await pump();
      if (endedEvent || nativeClosed) throw new Error('Host ended before observable freeze pause');
      return nativePausedAt !== null;
    }, 10000);
    if (faultStartAt === null) throw new Error('Missing test-only source fault evidence');
    evidence.freezePauseMs = nativePausedAt - faultStartAt;
    const stateAtPause = await page.evaluate(() => ({
      frames: window.supervisorProbe.frames,
      armed: window.supervisorProbe.armed,
      pauses: window.supervisorProbe.pauses,
    }));
    evidence.freezePause = stateAtPause;
    if (evidence.freezePauseMs < 2400 || evidence.freezePauseMs > 4500 || stateAtPause.armed)
      throw new Error('Native 3-second freeze pause not enforced');
    const expectedStage = {
      'capture-freeze': 'capture',
      'capture-recover': 'capture',
      'encode-freeze': 'encoded',
      'forward-freeze': 'forwarded',
      'render-freeze': 'rendered',
    }[mode];
    if (!healthHistory.some((event) => event.state === 'stalled' && event.stage === expectedStage))
      throw new Error(`Native freeze was not attributed to ${expectedStage}`);
    if (mode === 'capture-freeze' && scope === 'control') {
      // Simulate the independent input channel delivering a last in-flight
      // message after the state channel has announced pause. Recording only.
      await page.evaluate((sessionId) => {
        const p = window.supervisorProbe;
        if (!p.lastWindow) throw new Error('Missing last native ticket');
        const { controlEpoch, inputEpoch, layoutVersion, inputWindowId } = p.lastWindow;
        p.peer.inputChannel.send(
          JSON.stringify({
            version: 1,
            sessionId,
            controlEpoch,
            inputEpoch,
            layoutVersion,
            inputWindowId,
            seq: 4,
            type: 'key',
            payload: { code: 'KeyA', down: true },
          }),
        );
      }, binding.sessionId);
      const untilObserved = Date.now() + 250;
      await until(async () => {
        await pump();
        if (endedEvent || nativeClosed) throw new Error('In-flight input ended paused viewing');
        return Date.now() >= untilObserved;
      }, 1000);
      if ((await page.evaluate(() => window.supervisorProbe.acks.length)) !== 3)
        throw new Error('Native ACKed input after freeze pause');
      evidence.inFlightInputDiscardedWithoutEnding = true;
    }
    if (mode.startsWith('capture-')) {
      if (
        !latestProgress ||
        !faultProgress ||
        latestProgress.encodedSeq <= faultProgress.encodedSeq ||
        latestProgress.forwardedSeq <= faultProgress.forwardedSeq ||
        stateAtPause.frames <= evidence.media.frames + 10
      )
        throw new Error(
          'Capture freeze must preserve real encoded, forwarded and rendered progress',
        );
      evidence.cachedVideoContinuedDuringCaptureFreeze = true;
    }
    if (mode === 'render-freeze') {
      if (
        !latestProgress ||
        !faultProgress ||
        !['captureSeq', 'encodedSeq', 'forwardedSeq'].every(
          (field) => latestProgress[field] > faultProgress[field],
        )
      )
        throw new Error('Render-only freeze must preserve all source progress');
      evidence.sourceContinuedDuringRenderFreeze = true;
    }
    if (mode === 'forward-freeze') {
      if (
        !latestProgress ||
        !faultProgress ||
        !['captureSeq', 'encodedSeq'].every((field) => latestProgress[field] > faultProgress[field])
      )
        throw new Error('Forward-only freeze must preserve capture and encoder progress');
      evidence.captureAndEncodeContinuedDuringForwardFreeze = true;
    }
    if (mode === 'capture-recover') {
      await until(async () => {
        await pump();
        return resumedAt !== null && faultEndAt !== null;
      }, 7000);
      // Wait beyond the old ten-second cutoff: recovery restores viewing health,
      // while the blocked control epoch must remain blocked even after renewals.
      await until(async () => {
        await pump();
        if (
          nativeClosed ||
          endedEvent ||
          (await page.evaluate(() => !!window.supervisorProbe.ended))
        )
          throw new Error('Healthy recovery ended the session');
        return Date.now() - faultStartAt >= 11000;
      }, 12000);
      evidence.recoveredWithoutEnding = true;
      evidence.oldControlCannotArm = await page.evaluate(() => {
        const p = window.supervisorProbe;
        p.video.focus();
        return !p.armed && !p.peer.requestInputArm();
      });
      if (!evidence.oldControlCannotArm)
        throw new Error('Fresh frames or lease renewal restored old control');
      await page.evaluate((binding) => {
        const p = window.supervisorProbe;
        p.peer.stateChannel.send(
          JSON.stringify({
            version: 1,
            sessionId: binding.sessionId,
            negotiationId: binding.negotiationId,
            connectionGeneration: binding.controller.generation,
            type: 'input-arm',
            payload: { requestId: crypto.randomUUID(), controlEpoch: 1, layoutVersion: 1 },
          }),
        );
      }, binding);
      const untilObserved = Date.now() + 250;
      await until(async () => {
        await pump();
        if (
          nativeClosed ||
          endedEvent ||
          (await page.evaluate(() => !!window.supervisorProbe.ended))
        )
          throw new Error('Old arm granted or viewing ended after recovery');
        return Date.now() >= untilObserved;
      }, 1000);
      evidence.nativeRejectedOldArmWithoutEnding = true;
      send({ type: 'stop' });
    }
  }
  const stoppedAt = Date.now();
  if (mode === 'parent-kill') {
    closing = true;
    native.kill('SIGKILL');
  } else if (mode === 'stdin-eof') {
    closing = true;
    clearInterval(heartbeat);
    native.stdin.end();
  } else if (mode !== 'lease-expiry' && mode !== 'layout-change' && !freezeMode)
    send({ type: 'stop' });
  await until(async () => {
    await pump();
    return nativeClosed || !!endedEvent;
  }, 12000);
  evidence.stopMs = Date.now() - stoppedAt;
  if (mode === 'lease-expiry') evidence.fromLeaseToStopMs = Date.now() - leaseAt;
  if (mode === 'layout-change')
    evidence.layoutChangeEndMs = faultStartAt === null ? null : Date.now() - faultStartAt;
  if (freezeMode) {
    evidence.healthHistory = healthHistory;
    evidence.nativeStopReason = endedEvent?.reason;
    if (mode !== 'capture-recover') {
      evidence.freezeEndMs = Date.now() - faultStartAt;
      if (
        evidence.freezeEndMs < 9000 ||
        evidence.freezeEndMs > 12500 ||
        evidence.nativeStopReason !== 'MediaStalled'
      )
        throw new Error('Native ten-second frozen-session termination not proven');
    }
    if (evidence.leasesInstalled < 3)
      throw new Error('Freeze test ended before lease renewals were exercised');
  }
  await delay(mode === 'parent-kill' ? 4000 : 700);
  await pump();
  if (mode === 'layout-change') {
    evidence.nativeStopReason = endedEvent?.reason;
    if (
      evidence.nativeStopReason !== 'LayoutChanged' ||
      evidence.engineStopped?.screenStopReason !== 'MEDIA_LAYOUT_CHANGED' ||
      evidence.layoutChangeEndMs === null ||
      evidence.layoutChangeEndMs > 2000
    )
      throw new Error('Layout change did not promptly stop native input and capture');
  }
  const before = await page.evaluate(() => window.supervisorProbe.frames);
  await delay(500);
  const after = await page.evaluate(() => window.supervisorProbe.frames);
  evidence.framesStableAfterStop = before === after;
  evidence.engineExited = !exists(enginePid);
  evidence.sourceExited = !exists(sourcePid);
  evidence.nativeExit = nativeExit;
  if (mode === 'layout-change') {
    await until(async () => {
      await pump();
      return page.evaluate(() => !!window.supervisorProbe.ended && !window.supervisorProbe.armed);
    }, 4500);
    evidence.browserInputStopped = true;
  }
  evidence.browserEnd = await page.evaluate(() => window.supervisorProbe.ended);
  if (!evidence.framesStableAfterStop || !evidence.engineExited || !evidence.sourceExited)
    throw new Error('Media/child survived stop');
  console.log(JSON.stringify({ status: 'passed', ...evidence }));
} catch (error) {
  evidence.nativeFailure = events
    .filter((event) => ['error', 'ended', 'stopped'].includes(event.event))
    .map((event) => ({
      event: event.event,
      code: event.code,
      reason: event.reason,
      stopReason: event.stopReason,
    }));
  if (page)
    evidence.failureMedia = await page
      .evaluate(async () => {
        const p = window.supervisorProbe;
        if (!p) return null;
        const stats = await p.peer.peer.getStats();
        return {
          frames: p.frames,
          published: p.published,
          pauses: p.pauses,
          lastInspection: p.lastMediaInspection,
          stats: p.lastStats,
          width: p.video.videoWidth,
          height: p.video.videoHeight,
          paused: p.video.paused,
          readyState: p.video.readyState,
          playbackFrames: p.video.getVideoPlaybackQuality?.().totalVideoFrames,
          received: [...stats.values()]
            .filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')
            .map((s) => ({
              bytesReceived: s.bytesReceived,
              framesDecoded: s.framesDecoded,
              framesReceived: s.framesReceived,
            })),
        };
      })
      .catch(() => null);
  error.message += ` Evidence=${JSON.stringify(evidence)} stderr=${stderr}`;
  throw error;
} finally {
  closing = true;
  clearInterval(heartbeat);
  if (native && !nativeClosed) {
    send({ type: 'stop' });
    native.stdin.end();
    for (let i = 0; i < 30 && !nativeClosed; i++) await delay(100);
    if (!nativeClosed) native.kill('SIGKILL');
  }
  if (page)
    await page
      .evaluate(() => {
        const p = window.supervisorProbe;
        if (p) {
          clearInterval(p.inspectTimer);
          clearInterval(p.testHeartbeat);
          p.peer.end('TEST_CLEANUP');
        }
      })
      .catch(() => {});
  await browser?.close();
  lines?.close();
  await vite?.close();
  // Both native EOF watchdogs have time to reap their children even if a test failed.
  for (let i = 0; i < 50 && (exists(sourcePid) || exists(enginePid)); i++) await delay(100);
  await rm(dir, { recursive: true, force: true });
}
