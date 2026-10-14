import { expect, test } from '@playwright/test';

test('远控主控通过真实WebRTC和签名握手接收视频、发送有序输入并在冻结后停止', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const { RemoteControlPeer, sdpSha256Fingerprint } = await import(
      /* @vite-ignore */ '/src/services/remoteControlPeer.ts'
    );
    const wait = async (condition: () => boolean, timeout = 10000) => {
      const until = performance.now() + timeout;
      while (!condition()) {
        if (performance.now() > until) throw new Error('browser fixture timeout');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const base64 = (bytes: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const key = {
      keyId: 'browser-test',
      publicKey: base64(await crypto.subtle.exportKey('raw', pair.publicKey)),
      notBefore: Date.now() - 1000,
      notAfter: Date.now() + 60000,
    };
    const endpoint = {
      userId: 1,
      sid: crypto.randomUUID(),
      authVersion: crypto.randomUUID(),
      endpointId: crypto.randomUUID(),
      connectionId: 'host-socket',
      generation: 1,
    };
    const binding = {
      sessionId: crypto.randomUUID(),
      host: endpoint,
      controller: {
        ...endpoint,
        userId: 2,
        endpointId: crypto.randomUUID(),
        connectionId: 'controller-socket',
      },
      negotiationId: crypto.randomUUID(),
      consentNonce: base64(crypto.getRandomValues(new Uint8Array(32))),
      screenId: 'primary',
    };
    const layout = {
      screenId: 'primary',
      layoutVersion: 1,
      geometry: {
        displayId: 1,
        coordinateSpace: 'quartz-global-logical',
        displayBounds: { x: -1440, y: 0, width: 1440, height: 1080 },
        displayPixels: { width: 2880, height: 2160 },
        rotationDegrees: 0,
        encodedSize: { width: 320, height: 180 },
        contentRect: { x: 40, y: 0, width: 240, height: 180 },
      },
    };
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const hostStream = canvas.captureStream(15);
    let frame = 0;
    let consentNonce = binding.consentNonce;
    let authorizationRevision = 1;
    let controlEpoch = 1;
    const drawing = setInterval(() => {
      context.fillStyle = '#000';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = frame++ % 2 ? '#2563eb' : '#dc2626';
      context.fillRect(40, 0, 240, 180);
    }, 60);
    const video = document.createElement('video');
    video.tabIndex = 0;
    video.style.cssText =
      'position:fixed;top:0;left:0;width:320px;height:240px;object-fit:contain;z-index:99999';
    document.body.append(video);
    const host = new RTCPeerConnection({ iceServers: [] });
    hostStream.getTracks().forEach((track) => host.addTrack(track, hostStream));
    let hostState: RTCDataChannel | null = null;
    let hostInput: RTCDataChannel | null = null;
    let ready = false;
    let published = 0;
    let ended = '';
    let armed = false;
    let inputEpoch = 0;
    const pauses: string[] = [];
    const received: any[] = [];
    const armProgress: boolean[] = [];
    let previousState: any = null;
    const sendState = (type: string, payload: object = {}) =>
      hostState?.send(
        JSON.stringify({
          version: 1,
          ...{
            sessionId: binding.sessionId,
            negotiationId: binding.negotiationId,
            connectionGeneration: 1,
          },
          type,
          payload,
        }),
      );
    let controller: any;
    const candidates: RTCIceCandidateInit[] = [];
    host.onicecandidate = (event) => {
      if (event.candidate)
        void controller.receiveSignal({
          negotiationId: binding.negotiationId,
          connectionGeneration: 1,
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        });
    };
    host.ondatachannel = (event) => {
      if (event.channel.label === 'rc-state-v1') {
        hostState = event.channel;
        hostState.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.type === 'hello')
            sendState('hello', { proofSignature: message.payload.proof.signature });
          if (message.type === 'input-arm') {
            armProgress.push(
              previousState?.type === 'heartbeat' && previousState.payload.renderedFrames > 0,
            );
            inputEpoch++;
            const input = {
              requestId: message.payload.requestId,
              controlEpoch,
              inputEpoch,
              layoutVersion: 1,
            };
            sendState('input-armed', input);
            sendState('input-window', { ...input, inputWindowId: crypto.randomUUID() });
          }
          previousState = message;
        };
      } else {
        hostInput = event.channel;
        hostInput.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          received.push(message);
          sendState('input-ack', {
            controlEpoch: message.controlEpoch,
            inputEpoch: message.inputEpoch,
            layoutVersion: message.layoutVersion,
            seq: message.seq,
          });
        };
      }
    };
    controller = new RemoteControlPeer({
      binding,
      iceServers: [],
      iceTransportPolicy: 'all',
      keys: [key],
      onSignal: async (signal: any) => {
        if (signal.type === 'offer') {
          await host.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          for (const candidate of candidates.splice(0)) await host.addIceCandidate(candidate);
          await host.setLocalDescription(await host.createAnswer());
          await controller.receiveSignal({
            negotiationId: binding.negotiationId,
            connectionGeneration: 1,
            type: 'answer',
            sdp: host.localDescription!.sdp,
          });
        } else if (host.remoteDescription) await host.addIceCandidate(signal.candidate);
        else candidates.push(signal.candidate);
      },
      onReady: () => {
        ready = true;
      },
      onStream: (stream: MediaStream | null) => {
        if (stream) published++;
      },
      onPauseInput: (reason: string) => pauses.push(reason),
      onEnd: (reason: string) => {
        ended = reason;
      },
      onInputArmed: (value: boolean) => {
        armed = value;
      },
    });
    controller.attachVideo(video);
    const proof = async (purpose: 'connection' | 'lease', sequence = 1) => {
      const now = Date.now();
      const claims = {
        ...binding,
        consentNonce,
        hostFingerprint: sdpSha256Fingerprint(host.localDescription!.sdp),
        controllerFingerprint: sdpSha256Fingerprint(controller.peer.localDescription.sdp),
        protocolVersion: 1,
        issuer: 'todesk-remote-control',
        audience: 'todesk-remote-peer',
        purpose,
        scope: 'control',
        authorizationRevision,
        controlEpoch,
        issuedAt: now,
        expiresAt: now + (purpose === 'lease' ? 15000 : 30000),
        ...(purpose === 'lease'
          ? { leaseSeq: sequence, challenge: base64(crypto.getRandomValues(new Uint8Array(32))) }
          : {}),
      };
      const payload = base64(new TextEncoder().encode(JSON.stringify(claims)));
      return {
        format: 'rc-signed-v1',
        keyId: key.keyId,
        payload,
        signature: base64(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            pair.privateKey,
            new TextEncoder().encode(`todesk-remote-control/v1\n${key.keyId}\n${payload}`),
          ),
        ),
      };
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renew: ReturnType<typeof setInterval> | undefined;
    try {
      await controller.start();
      await wait(() => !!hostState && hostState.readyState === 'open' && !!hostInput);
      const beforeAuthorization = published;
      await controller.installConnectionProof(await proof('connection'));
      await wait(() => ready);
      heartbeat = setInterval(() => {
        if (hostState?.readyState === 'open') sendState('heartbeat');
      }, 500);
      await controller.installMediaLease(await proof('lease'));
      await wait(
        () => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 1,
      );
      video.focus();
      const noLayoutCannotArm = !controller.requestInputArm();
      sendState('layout', layout);
      await wait(() => controller.mapPointer(160, 120) !== null);
      const pointerMapping = [
        [40, 30],
        [160, 120],
        [280, 210],
        [20, 120],
        [160, 10],
      ].map(([x, y]) => controller.mapPointer(x, y));
      const armRequested = controller.requestInputArm();
      await wait(() => armed);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.sendInput({
        type: 'button',
        payload: { ...controller.mapPointer(160, 120), button: 0, down: true },
      });
      controller.sendInput({
        type: 'button',
        payload: { ...controller.mapPointer(160, 120), button: 0, down: false },
      });
      await wait(() => received.length === 2);
      const framesBeforePause = video.getVideoPlaybackQuality().totalVideoFrames;
      sendState('pause', { reason: 'REMOTE_CAPTURE_STALLED' });
      await wait(() => !armed);
      await wait(() => video.getVideoPlaybackQuality().totalVideoFrames > framesBeforePause + 2);
      const framesDidNotRearm = !armed;
      video.focus();
      const oldLeaseCannotResume = !controller.requestInputArm();
      consentNonce = base64(crypto.getRandomValues(new Uint8Array(32)));
      authorizationRevision = 2;
      controlEpoch = 2;
      const approvalAccepted = controller.approveBindingUpdate({
        ...binding,
        consentNonce,
        authorizationRevision,
        controlEpoch,
      });
      const approvalDidNotArm = !armed;
      await controller.installMediaLease(await proof('lease', 2));
      const leaseDidNotArm = !armed;
      video.focus();
      controller.requestInputArm();
      await wait(() => armed);
      let leaseSeq = 2;
      renew = setInterval(() => {
        void proof('lease', ++leaseSeq).then((value) => controller.installMediaLease(value));
      }, 5000);
      clearInterval(drawing); // Real decoded video stops while the authenticated data heartbeat remains alive.
      await wait(() => pauses.includes('REMOTE_VIDEO_STALLED'), 6000);
      await wait(() => !!ended, 12000);
      return {
        beforeAuthorization,
        ready,
        noLayoutCannotArm,
        pointerMapping,
        armRequested,
        armProgress,
        framesDidNotRearm,
        oldLeaseCannotResume,
        approvalAccepted,
        approvalDidNotArm,
        leaseDidNotArm,
        width: video.videoWidth,
        seq: received.map((item) => item.seq),
        coordinates: received.map((item) => ({ x: item.payload.x, y: item.payload.y })),
        labels: [hostInput!.label, hostState!.label],
        ordered: [hostInput!.ordered, hostState!.ordered],
        pauses,
        ended,
        closed: controller.peer.connectionState,
      };
    } finally {
      clearInterval(drawing);
      if (heartbeat) clearInterval(heartbeat);
      if (renew) clearInterval(renew);
      controller.end('TEST_CLEANUP');
      host.close();
      hostStream.getTracks().forEach((track) => track.stop());
      video.remove();
    }
  });
  expect(result.beforeAuthorization).toBe(0);
  expect(result.ready).toBe(true);
  expect(result.noLayoutCannotArm).toBe(true);
  expect(result.pointerMapping).toEqual([
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
    null,
    null,
  ]);
  expect(result.armRequested).toBe(true);
  expect(result.seq).toEqual([1, 2]);
  expect(result.coordinates).toEqual([
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
  ]);
  expect(result.armProgress).toEqual([true, true]);
  expect(result.framesDidNotRearm).toBe(true);
  expect(result.oldLeaseCannotResume).toBe(true);
  expect(result.approvalAccepted).toBe(true);
  expect(result.approvalDidNotArm).toBe(true);
  expect(result.leaseDidNotArm).toBe(true);
  expect(result.labels).toEqual(['rc-input-v1', 'rc-state-v1']);
  expect(result.ordered).toEqual([true, true]);
  expect(result.pauses).toContain('REMOTE_VIDEO_STALLED');
  expect(result.ended).toBe('REMOTE_VIDEO_FROZEN');
  expect(result.closed).toBe('closed');
});
