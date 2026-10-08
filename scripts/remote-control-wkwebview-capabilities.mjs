// Explicit local interoperability regression. System WKWebView receives synthetic
// canvas H.264 from Chromium; no display/device capture, OS input, or ICE servers.
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWkBrowser } from './remote-control-wkwebview.mjs';

if (process.platform !== 'darwin' || process.argv.length !== 2) throw new Error('Usage on macOS: node scripts/remote-control-wkwebview-capabilities.mjs');
const require = createRequire(new URL('../client-vue/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const directory = await mkdtemp(join(tmpdir(), 'todesk-wk-capabilities-'));
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self'" });
  response.end('<!doctype html><html><meta charset="utf-8"><title>NearLink WKWebView 合成画面验证</title><body></body></html>');
});
const evidence = { browser: 'system-WKWebView', syntheticOnly: true, iceServers: [], candidatePolicy: 'loopback-first-then-verified-same-host-addresses', noDeviceCapture: true, noOsInput: true, framesStored: 0 };
let wk, chrome, receiver, sender;
const loopback = value => / (127\.0\.0\.1|::1) \d+ typ host(?: |$)/.test(value);
// Only destinations assigned to this computer are eligible. No arbitrary LAN
// candidate, mDNS resolution, server-reflexive candidate, or relay is admitted.
const ownedAddresses = new Set(Object.values(networkInterfaces()).flatMap(values => (values || []).map(value => value.address)));
const ownedHostCandidate = value => {
  const match = /^candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ host(?: |$)/i.exec(value);
  return !!match && ownedAddresses.has(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535;
};
const cleanSdp = sdp => sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') || loopback(line)).join('\r\n');
const fingerprint = sdp => [...new Set([...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(match => match[1].replaceAll(':', '').toUpperCase()))];
const counts = { wk: { loopback: 0, mdns: 0, other: 0 }, chromium: { loopback: 0, mdns: 0, other: 0, verifiedSameHost: 0 } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  wk = await createWkBrowser(directory);
  receiver = await wk.newPage();
  await receiver.goto(url);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const message = Buffer.from('todesk-remote-control/v1\nwk-capabilities\nsynthetic-test');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  evidence.platform = await receiver.evaluate(async ({ publicKey, signature, message }) => {
    const bytes = text => Uint8Array.from(atob(text), value => value.charCodeAt(0));
    let ed25519;
    try {
      const key = await crypto.subtle.importKey('raw', bytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, bytes(signature), bytes(message));
      const tampered = bytes(message); tampered[0] ^= 1;
      ed25519 = { valid, tamperedRejected: !await crypto.subtle.verify({ name: 'Ed25519' }, key, bytes(signature), tampered) };
    } catch (error) { ed25519 = { error: String(error) }; }
    const video = document.createElement('video');
    return { userAgent: navigator.userAgent, secureContext: isSecureContext, ed25519,
      requestVideoFrameCallback: typeof video.requestVideoFrameCallback === 'function',
      getVideoPlaybackQuality: typeof video.getVideoPlaybackQuality === 'function',
      h264: (RTCRtpReceiver.getCapabilities('video')?.codecs || []).filter(codec => codec.mimeType.toLowerCase() === 'video/h264').map(codec => codec.sdpFmtpLine || '') };
  }, { publicKey: raw.toString('base64'), signature: sign(null, message, privateKey).toString('base64'), message: message.toString('base64') });

  chrome = await chromium.launch({ headless: true, args: ['--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  sender = await chrome.newPage();
  await sender.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  await sender.goto(url);
  const setup = async role => {
    const state = window.wkCapability = { role, candidates: [], errors: [], channels: [], frames: 0, echoes: [], drawing: null, stream: null, video: null, callback: null };
    const peer = state.peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    peer.onicecandidate = ({ candidate }) => { if (candidate) state.candidates.push(candidate.toJSON()); };
    const listen = channel => {
      state.channels.push(channel);
      channel.onmessage = ({ data }) => { if (role === 'sender') channel.send(data); else state.echoes.push(data); };
      if (role === 'receiver') channel.onopen = () => channel.send(`ordered:${channel.label}`);
    };
    const codecs = (RTCRtpReceiver.getCapabilities('video')?.codecs || []).filter(codec =>
      codec.mimeType.toLowerCase() === 'video/h264' && /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(codec.sdpFmtpLine || '')
      && /(?:^|;)\s*profile-level-id=42e01f(?:;|$)/i.test(codec.sdpFmtpLine || ''));
    if (!codecs.length) throw new Error('CONSTRAINED_BASELINE_H264_NOT_AVAILABLE');
    if (role === 'receiver') {
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' }); transceiver.setCodecPreferences(codecs);
      listen(peer.createDataChannel('rc-input-v1', { ordered: true }));
      listen(peer.createDataChannel('rc-state-v1', { ordered: true }));
      const video = state.video = document.createElement('video');
      video.autoplay = true; video.muted = true; video.playsInline = true; video.width = 320; video.height = 180;
      document.body.append(video);
      const rendered = () => { state.frames++; state.callback = video.requestVideoFrameCallback(rendered); };
      if (typeof video.requestVideoFrameCallback === 'function') state.callback = video.requestVideoFrameCallback(rendered);
      peer.ontrack = ({ track }) => { video.srcObject = new MediaStream([track]); video.play().catch(error => state.errors.push(String(error))); };
    } else {
      peer.ondatachannel = ({ channel }) => listen(channel);
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'); let frame = 0;
      const draw = () => { context.fillStyle = frame++ % 2 ? '#2563eb' : '#dc2626'; context.fillRect(0, 0, 320, 180); };
      draw(); state.drawing = setInterval(draw, 60);
      state.stream = canvas.captureStream(15);
      peer.addTrack(state.stream.getVideoTracks()[0], state.stream);
      peer.getTransceivers()[0].setCodecPreferences(codecs);
    }
    return { role, dtlsPrototypeGetRemoteCertificates: typeof RTCDtlsTransport !== 'undefined' && typeof RTCDtlsTransport.prototype.getRemoteCertificates === 'function' };
  };
  evidence.receiver = await receiver.evaluate(setup, 'receiver');
  await sender.evaluate(setup, 'sender');
  const offer = await receiver.evaluate(async () => { const pc = window.wkCapability.peer; await pc.setLocalDescription(await pc.createOffer()); return pc.localDescription.sdp; });
  const answer = await sender.evaluate(async sdp => { const pc = window.wkCapability.peer; await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer()); return pc.localDescription.sdp; }, cleanSdp(offer));
  await receiver.evaluate(sdp => window.wkCapability.peer.setRemoteDescription({ type: 'answer', sdp }), cleanSdp(answer));
  const expectedFingerprints = fingerprint(answer);
  if (expectedFingerprints.length !== 1) throw new Error('Ambiguous sender DTLS fingerprints');
  const heldSameHost = [];
  const forward = async (from, to, bucket) => {
    const candidates = await from.evaluate(() => window.wkCapability.candidates.splice(0));
    for (const candidate of candidates) {
      if (loopback(candidate.candidate)) { bucket.loopback++; await to.evaluate(candidate => window.wkCapability.peer.addIceCandidate(candidate), candidate); }
      else if (/ [^ ]+\.local \d+ typ host(?: |$)/i.test(candidate.candidate)) bucket.mdns++;
      else if (from === sender && ownedHostCandidate(candidate.candidate)) heldSameHost.push(candidate);
      else bucket.other++;
    }
  };
  const started = Date.now();
  let media;
  do {
    await forward(receiver, sender, counts.wk);
    await forward(sender, receiver, counts.chromium);
    if (Date.now() - started >= 2000 && heldSameHost.length) {
      evidence.strictLoopbackFirstAttemptConnected = media?.connectionState === 'connected';
      for (const candidate of heldSameHost.splice(0)) {
        counts.chromium.verifiedSameHost++;
        await receiver.evaluate(candidate => window.wkCapability.peer.addIceCandidate(candidate), candidate);
      }
    }
    media = await receiver.evaluate(() => { const state = window.wkCapability; return { connectionState: state.peer.connectionState, iceConnectionState: state.peer.iceConnectionState, frames: state.frames, playbackQualityFrames: state.video?.getVideoPlaybackQuality?.().totalVideoFrames || 0, width: state.video?.videoWidth || 0, height: state.video?.videoHeight || 0, echoes: state.echoes, errors: state.errors,
      channels: state.channels.map(channel => ({ label: channel.label, ordered: channel.ordered, maxRetransmits: channel.maxRetransmits, maxPacketLifeTime: channel.maxPacketLifeTime, readyState: channel.readyState })) }; });
    if (media.frames >= 5 && media.echoes.length === 2) break;
    await delay(50);
  } while (Date.now() - started < 12000);
  evidence.ice = counts;
  evidence.media = { ...media, elapsedMs: Date.now() - started };
  evidence.dtls = await receiver.evaluate(async ({ expected, ownedAddresses }) => {
    const peer = window.wkCapability.peer, transport = peer.sctp?.transport;
    const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    const result = { state: transport?.state ?? null, getRemoteCertificates: typeof transport?.getRemoteCertificates === 'function', directMatchesSdp: false, stats: [] };
    if (result.getRemoteCertificates) {
      try { const certificates = transport.getRemoteCertificates(); result.directCertificateCount = certificates.length; result.directMatchesSdp = certificates.length > 0 && await hash(certificates[0]) === expected; }
      catch (error) { result.directError = String(error); }
    }
    const report = await peer.getStats();
    for (const entry of report.values()) {
      if (entry.type !== 'transport') continue;
      const certificate = entry.remoteCertificateId ? report.get(entry.remoteCertificateId) : null;
      const pair = entry.selectedCandidatePairId ? report.get(entry.selectedCandidatePairId) : null;
      const local = pair ? report.get(pair.localCandidateId) : null;
      const remote = pair ? report.get(pair.remoteCandidateId) : null;
      const remoteAddress = remote?.address ?? remote?.ip;
      const current = { dtlsState: entry.dtlsState ?? null, hasRemoteCertificateId: !!entry.remoteCertificateId, hasDer: !!certificate?.base64Certificate,
        fingerprintAlgorithm: certificate?.fingerprintAlgorithm ?? null, statsFingerprintMatchesSdp: certificate?.fingerprint?.replaceAll(':', '').toUpperCase() === expected,
        certificateDerMatchesSdp: false, localCandidateType: local?.candidateType ?? null, remoteCandidateType: remote?.candidateType ?? null,
        remoteAddressVisible: typeof remoteAddress === 'string' && !!remoteAddress,
        remoteAddressIsLoopback: remoteAddress ? ['127.0.0.1', '::1'].includes(remoteAddress) : null,
        remoteAddressBelongsToThisHost: remoteAddress ? ownedAddresses.includes(remoteAddress) : null };
      if (certificate?.base64Certificate) {
        try { current.certificateDerMatchesSdp = await hash(Uint8Array.from(atob(certificate.base64Certificate), value => value.charCodeAt(0))) === expected; }
        catch (error) { current.certificateError = String(error); }
      }
      result.stats.push(current);
    }
    result.inbound = [...report.values()].filter(entry => entry.type === 'inbound-rtp' && entry.kind === 'video').map(entry => ({ framesDecoded: entry.framesDecoded, codec: report.get(entry.codecId)?.mimeType, fmtp: report.get(entry.codecId)?.sdpFmtpLine }));
    return result;
  }, { expected: expectedFingerprints[0], ownedAddresses: [...ownedAddresses] });
  const reliableChannels = media.channels.length === 2 && media.channels.every(channel => channel.ordered && channel.maxRetransmits === null && channel.maxPacketLifeTime === null && channel.readyState === 'open');
  const expectedEchoes = ['ordered:rc-input-v1', 'ordered:rc-state-v1'].every(value => media.echoes.includes(value));
  evidence.currentPeerCompatible = !!(evidence.platform.ed25519.valid && evidence.platform.ed25519.tamperedRejected && media.frames >= 5 && reliableChannels && expectedEchoes && evidence.dtls.directMatchesSdp);
  evidence.blockers = [];
  if (!evidence.platform.ed25519.valid || !evidence.platform.ed25519.tamperedRejected) evidence.blockers.push('ED25519_UNAVAILABLE');
  if (media.frames < 5 || !reliableChannels || !expectedEchoes) evidence.blockers.push('SAME_HOST_WEBRTC_NOT_ESTABLISHED');
  if (evidence.dtls.state !== 'connected') evidence.blockers.push('ACTUAL_DTLS_CERTIFICATE_UNTESTED_WITHOUT_CONNECTION');
  else if (!evidence.dtls.directMatchesSdp) evidence.blockers.push('CURRENT_PEER_REQUIRES_MATCHING_REMOTE_CERTIFICATE');
  if (!evidence.currentPeerCompatible) process.exitCode = 1;
} catch (error) {
  evidence.error = String(error); process.exitCode = 1;
} finally {
  const cleanup = () => { const state = window.wkCapability; if (!state) return; clearInterval(state.drawing); if (state.callback !== null) state.video?.cancelVideoFrameCallback?.(state.callback); state.peer.close(); state.stream?.getTracks().forEach(track => track.stop()); if (state.video) { state.video.srcObject = null; state.video.remove(); } };
  if (receiver) await receiver.evaluate(cleanup).catch(() => {});
  if (sender) await sender.evaluate(cleanup).catch(() => {});
  if (wk) await wk.close();
  if (chrome) await chrome.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(evidence));
}
