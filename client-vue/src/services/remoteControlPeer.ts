import { isMdnsCandidate, withoutMdnsCandidates } from './remoteControlIce';
import { RemoteInputSender, remoteVideoCoordinates, type RemoteInputContext, type RemoteInputEvent } from './remoteControlInput';
import { parseRemoteControlLayout, sameRemoteControlLayout, type RemoteControlLayout } from './remoteControlGeometry';
import { verifyRemoteProof, type RemotePeerBinding, type RemoteSigningKey, type RemoteSignedEnvelope, type VerifiedRemoteProof } from './remoteControlProof';
import { createRequestId } from '@/utils/requestId';

export type RemotePeerSignal = { negotiationId: string; connectionGeneration: number } & (
  { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: RTCIceCandidateInit }
);
export interface RemoteControlApproval extends Omit<RemotePeerBinding, 'hostFingerprint' | 'controllerFingerprint'> { authorizationRevision: number; controlEpoch: number }
export interface RemotePeerStats { roundTripMs: number | null; framesPerSecond: number; bitrate: number; packetsLost: number; relay: boolean | null }
export interface RemotePeerOptions {
  binding: Omit<RemotePeerBinding, 'hostFingerprint' | 'controllerFingerprint'>;
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  keys: readonly RemoteSigningKey[];
  onSignal(signal: RemotePeerSignal): void | Promise<void>;
  onReady(): void | Promise<void>;
  onStream(stream: MediaStream | null): void;
  onPauseInput(reason: string): void;
  onEnd(reason: string): void;
  onStats?(stats: RemotePeerStats): void;
  onInputArmed?(armed: boolean): void;
  onInputWindow?(): void;
  onAuthorization?(scope: 'view' | 'control'): void;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
  verifyProof?: typeof verifyRemoteProof;
}
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export function sdpSha256Fingerprint(sdp: string) {
  if (sdp.split(/\r?\n/).some(line => line.startsWith('a=fingerprint:') && !/^a=fingerprint:sha-256 [A-Fa-f0-9:]+$/.test(line))) throw new Error('REMOTE_DTLS_FINGERPRINT');
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(match => match[1]!.replace(/:/g, '').toUpperCase());
  if (!values.length || values.some(value => !/^[A-F0-9]{64}$/.test(value) || value !== values[0])) throw new Error('REMOTE_DTLS_FINGERPRINT');
  return values[0]!;
}
export function allowedRemoteVideoCodecs(codecs: RTCRtpCodec[]) {
  // The released native encoder emits H.264 constrained-baseline only. Offering
  // VP8 first can negotiate a format the host cannot feed into its RTP pipeline.
  return codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'
    && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine || '')
    && /(?:^|;)\s*profile-level-id=42e01f(?:;|$)/i.test(codec.sdpFmtpLine || ''));
}

/** Real WebRTC controller transport. No ordinary ACK/state/open event can authorize media or input. */
export class RemoteControlPeer {
  readonly peer: RTCPeerConnection;
  readonly inputChannel: RTCDataChannel;
  readonly stateChannel: RTCDataChannel;
  readonly input: RemoteInputSender;
  private readonly now: () => number;
  private stopped = false;
  private started = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private receivedCandidates = 0;
  private sentCandidates = 0;
  private incomingSignal = Promise.resolve();
  private stream = new MediaStream();
  private connectionProof: VerifiedRemoteProof | null = null;
  private lease: VerifiedRemoteProof | null = null;
  private proofGeneration = 0;
  private expectedApproval: RemoteControlApproval | null = null;
  private helloReceived = false;
  private helloSending = false;
  private actualDtlsVerified = false;
  private readySent = false;
  private lastHeartbeat = 0;
  private lastHeartbeatSent = -Infinity;
  private lastFrame = 0;
  private frozen = false;
  private hostPaused = false;
  private frameCount = 0;
  private layout: RemoteControlLayout | null = null;
  private armRequest: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private video: HTMLVideoElement | null = null;
  private videoCallback: number | null = null;
  private previousVideoFrames = 0;
  private lastStats: { timestamp: number; bytes: number } | null = null;
  private connectDeadline: number;

  constructor(private readonly options: RemotePeerOptions) {
    this.now = options.now || (() => performance.now());
    this.connectDeadline = this.now() + 30000;
    this.peer = (options.createPeer || (configuration => new RTCPeerConnection(configuration)))({ iceServers: options.iceServers, iceTransportPolicy: options.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const video = this.peer.addTransceiver('video', { direction: 'recvonly' });
    const codecs = allowedRemoteVideoCodecs(RTCRtpReceiver.getCapabilities('video')?.codecs || []);
    if (!codecs.length || typeof video.setCodecPreferences !== 'function') { this.peer.close(); throw new Error('REMOTE_VIDEO_CODEC_UNSUPPORTED'); }
    try { video.setCodecPreferences(codecs); } catch (error) { this.peer.close(); throw error; }
    this.inputChannel = this.peer.createDataChannel('rc-input-v1', { ordered: true });
    this.stateChannel = this.peer.createDataChannel('rc-state-v1', { ordered: true });
    const inputChannel = this.inputChannel;
    this.input = new RemoteInputSender({
      get readyState() { return inputChannel.readyState; },
      get bufferedAmount() { return inputChannel.bufferedAmount; },
      send: data => {
        if (!this.decodedGeometryReady()) throw new Error('REMOTE_VIDEO_GEOMETRY_UNAVAILABLE');
        inputChannel.send(data);
      },
    }, (reason, context) => {
      this.sendState('release-all', { ...context, reason });
      this.options.onInputArmed?.(false);
      this.options.onPauseInput(reason);
    }, this.now);
    this.peer.onicecandidate = event => {
      if (!event.candidate || this.stopped) return;
      const candidate = event.candidate.toJSON();
      if (isMdnsCandidate(candidate.candidate || '')) return;
      if (++this.sentCandidates > 128 || utf8Bytes(JSON.stringify(candidate)) > 4096) { this.end('REMOTE_ICE_LIMIT'); return; }
      void Promise.resolve(options.onSignal({ ...this.signalBinding(), type: 'candidate', candidate })).catch(() => this.end('REMOTE_SIGNAL_FAILED'));
    };
    this.peer.ontrack = event => {
      if (this.stopped || event.track.kind !== 'video' || this.stream.getVideoTracks().length) { event.track.stop(); if (!this.stopped) this.end('REMOTE_UNEXPECTED_TRACK'); return; }
      this.stream.addTrack(event.track);
      event.track.onended = () => this.end('REMOTE_TRACK_ENDED');
      if (this.lease) this.publishStream();
    };
    this.peer.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(this.peer.connectionState)) this.end('REMOTE_CONNECTION_LOST'); };
    this.peer.ondatachannel = event => { event.channel.close(); this.end('REMOTE_UNEXPECTED_CHANNEL'); };
    for (const channel of [this.inputChannel, this.stateChannel]) {
      channel.onclose = () => this.end('REMOTE_CHANNEL_CLOSED');
      channel.onerror = () => this.end('REMOTE_CHANNEL_ERROR');
    }
    this.stateChannel.onopen = () => { void this.sendHello(); };
    this.stateChannel.onmessage = event => this.receiveState(event.data);
    this.inputChannel.onmessage = () => this.end('REMOTE_INPUT_DIRECTION');
    this.timer = setInterval(() => this.tick(), 100);
    this.statsTimer = setInterval(() => { void this.collectStats(); }, 2000);
  }

  async start() {
    if (this.started || this.stopped) throw new Error('REMOTE_ALREADY_STARTED');
    this.started = true;
    const offer = await this.peer.createOffer();
    if (this.stopped) return;
    if (!offer.sdp || utf8Bytes(offer.sdp) > 65536) { this.end('REMOTE_SDP_LIMIT'); return; }
    await this.peer.setLocalDescription(offer);
    if (!this.stopped) await this.options.onSignal({ ...this.signalBinding(), type: 'offer', sdp: withoutMdnsCandidates(this.peer.localDescription!.sdp) });
  }

  receiveSignal(signal: RemotePeerSignal) {
    if (this.stopped || signal.negotiationId !== this.options.binding.negotiationId || signal.connectionGeneration !== this.options.binding.host.generation) return Promise.resolve(false);
    if (signal.type === 'candidate' && (++this.receivedCandidates > 128 || utf8Bytes(JSON.stringify(signal.candidate)) > 4096)) { this.end('REMOTE_ICE_LIMIT'); return Promise.resolve(false); }
    const result = this.incomingSignal.then(async () => {
      if (this.stopped) return false;
      if (signal.type === 'answer') {
        if (this.peer.remoteDescription || utf8Bytes(signal.sdp) > 65536) throw new Error('REMOTE_SDP_LIMIT');
        sdpSha256Fingerprint(signal.sdp);
        await this.peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        for (const candidate of this.pendingCandidates.splice(0)) await this.peer.addIceCandidate(candidate);
      } else if (signal.type === 'candidate') {
        if (!this.peer.remoteDescription) this.pendingCandidates.push(signal.candidate);
        else await this.peer.addIceCandidate(signal.candidate);
      } else throw new Error('REMOTE_SIGNAL_DIRECTION');
      return true;
    });
    this.incomingSignal = result.then(() => undefined, () => undefined);
    return result.catch(error => { this.end(error instanceof Error ? error.message : 'REMOTE_SIGNAL_FAILED'); return false; });
  }

  async installConnectionProof(proof: RemoteSignedEnvelope) {
    const generation = this.proofGeneration;
    const verified = await this.verify(proof, 'connection');
    if (this.stopped || generation !== this.proofGeneration) return false;
    if (this.connectionProof) throw new Error('REMOTE_CONNECTION_PROOF_REPLACED');
    this.connectionProof = verified;
    this.connectDeadline = Math.min(this.connectDeadline, verified.deadline);
    this.lastHeartbeat = this.now();
    await this.sendHello();
    return !this.stopped;
  }

  async installMediaLease(proof: RemoteSignedEnvelope) {
    if (!this.connectionProof || !this.helloReceived || !this.readySent) throw new Error('REMOTE_HANDSHAKE_REQUIRED');
    if (this.lease && this.now() >= this.lease.deadline) { this.end('REMOTE_LEASE_EXPIRED'); return false; }
    const generation = this.proofGeneration;
    const verified = await this.verify(proof, 'lease');
    if (this.stopped || generation !== this.proofGeneration) return false;
    const previous = this.lease;
    if (previous && this.now() >= previous.deadline) { this.end('REMOTE_LEASE_EXPIRED'); return false; }
    if (this.expectedApproval && (verified.claims.authorizationRevision !== this.expectedApproval.authorizationRevision || verified.claims.controlEpoch !== this.expectedApproval.controlEpoch || verified.claims.scope !== 'control')) throw new Error('REMOTE_APPROVAL_LEASE_MISMATCH');
    if (previous && (verified.claims.leaseSeq! <= previous.claims.leaseSeq! || verified.claims.authorizationRevision < previous.claims.authorizationRevision || verified.claims.controlEpoch < previous.claims.controlEpoch)) throw new Error('REMOTE_LEASE_REPLAY');
    if (previous && (verified.claims.controlEpoch !== previous.claims.controlEpoch || verified.claims.scope !== previous.claims.scope)) this.pauseInput('REMOTE_AUTHORIZATION_CHANGED');
    this.lease = verified;
    if (previous && verified.claims.controlEpoch > previous.claims.controlEpoch && verified.claims.scope === 'control') this.hostPaused = false;
    if (!previous || previous.claims.controlEpoch !== verified.claims.controlEpoch || previous.claims.scope !== verified.claims.scope) this.options.onAuthorization?.(verified.claims.scope);
    if (this.expectedApproval) { this.options.binding.consentNonce = this.expectedApproval.consentNonce; this.expectedApproval = null; }
    if (!previous) { this.lastFrame = this.now(); this.publishStream(); }
    // Renewing a lease never resumes input or revives a frozen frame.
    return true;
  }

  approveBindingUpdate(approval: RemoteControlApproval) {
    if (this.stopped || !this.lease || this.now() >= this.lease.deadline) { this.end('REMOTE_LEASE_EXPIRED'); return false; }
    const original = this.options.binding;
    const previous = this.expectedApproval || this.lease.claims;
    const endpointFields = ['userId', 'sid', 'authVersion', 'endpointId', 'connectionId', 'generation'] as const;
    const matches = (name: 'host' | 'controller') => endpointFields.every(field => approval[name]?.[field] === original[name][field]);
    if (approval.sessionId !== original.sessionId || approval.screenId !== original.screenId || approval.negotiationId !== original.negotiationId || !matches('host') || !matches('controller')
      || !/^[A-Za-z0-9_-]{43}$/.test(approval.consentNonce) || approval.consentNonce === previous.consentNonce
      || !Number.isSafeInteger(approval.authorizationRevision) || !Number.isSafeInteger(approval.controlEpoch) || approval.authorizationRevision <= previous.authorizationRevision || approval.controlEpoch <= previous.controlEpoch) return false;
    this.pauseInput('REMOTE_APPROVAL_PENDING_LEASE');
    this.expectedApproval = { ...approval };
    return true;
  }

  attachVideo(video: HTMLVideoElement | null) {
    if (this.video && this.videoCallback !== null) this.video.cancelVideoFrameCallback?.(this.videoCallback);
    if (this.video) { this.video.removeEventListener('resize', this.onVideoResize); this.video.srcObject = null; }
    this.videoCallback = null;
    this.video = video;
    video?.addEventListener('resize', this.onVideoResize);
    if (video && this.lease && !this.stopped) this.publishStream();
  }

  mapPointer(clientX: number, clientY: number) {
    if (!this.decodedGeometryReady() || !this.video || !this.layout) return null;
    return remoteVideoCoordinates(clientX, clientY, this.video.getBoundingClientRect(), this.video.videoWidth, this.video.videoHeight, this.layout.geometry);
  }

  private readonly onVideoResize = () => { this.decodedGeometryReady(); };
  private decodedGeometryReady() {
    if (this.stopped || !this.layout || !this.video) return false;
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height) { if (this.input.armed) this.pauseInput('REMOTE_VIDEO_UNAVAILABLE'); return false; }
    if (width !== this.layout.geometry.encodedSize.width || height !== this.layout.geometry.encodedSize.height) {
      this.end('REMOTE_VIDEO_GEOMETRY_MISMATCH'); return false;
    }
    return true;
  }

  requestInputArm() {
    if (!this.decodedGeometryReady() || !this.lease || this.lease.claims.scope !== 'control' || this.now() >= this.lease.deadline || this.frozen || this.hostPaused || this.frameCount === 0 || !this.layout || !this.video || document.hidden || document.activeElement !== this.video || this.now() - this.lastFrame >= 3000) return false;
    this.armRequest = null;
    // The host must observe a rendered frame before considering this explicit
    // arm request. Both messages share the same reliable, ordered channel.
    if (!this.sendState('heartbeat', { renderedFrames: this.frameCount })) return false;
    this.lastHeartbeatSent = this.now();
    this.armRequest = createRequestId();
    if (!this.sendState('input-arm', { requestId: this.armRequest, controlEpoch: this.lease.claims.controlEpoch, layoutVersion: this.layout.layoutVersion })) { this.armRequest = null; return false; }
    return true;
  }

  sendInput(event: RemoteInputEvent) { return this.decodedGeometryReady() && !!this.lease && this.now() < this.lease.deadline && !this.frozen && this.input.enqueue(event); }
  observeAuthorization(scope: 'view' | 'control', authorizationRevision: number, controlEpoch: number) {
    if (!this.lease) return;
    if (scope === 'view' || authorizationRevision > this.lease.claims.authorizationRevision || controlEpoch > this.lease.claims.controlEpoch) { this.hostPaused = true; this.pauseInput('REMOTE_AUTHORIZATION_CHANGED'); }
  }
  pauseInput(reason: string) { this.armRequest = null; this.input.pause(reason); this.options.onInputArmed?.(false); }

  end(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.proofGeneration++;
    this.pauseInput(reason);
    this.input.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = this.statsTimer = null;
    this.attachVideo(null);
    for (const track of this.stream.getTracks()) { track.onended = null; track.stop(); }
    this.inputChannel.onclose = this.stateChannel.onclose = null;
    this.inputChannel.close(); this.stateChannel.close();
    this.peer.onconnectionstatechange = null;
    this.peer.close();
    this.pendingCandidates = [];
    this.lease = this.connectionProof = null;
    this.options.onStream(null);
    this.options.onEnd(reason);
  }

  private binding(): RemotePeerBinding {
    return { ...this.options.binding, controllerFingerprint: sdpSha256Fingerprint(this.peer.localDescription?.sdp || ''), hostFingerprint: sdpSha256Fingerprint(this.peer.remoteDescription?.sdp || '') };
  }
  private async verify(proof: RemoteSignedEnvelope, purpose: 'connection' | 'lease') {
    const binding = this.binding();
    if (purpose === 'lease' && this.expectedApproval) binding.consentNonce = this.expectedApproval.consentNonce;
    const verify = () => (this.options.verifyProof || verifyRemoteProof)(proof, this.options.keys, binding, purpose,
      { wall: Date.now(), monotonic: this.now() });
    try { return await verify(); }
    catch (error) {
      // A fresh proof can arrive before its signed issue time on a slightly
      // slower local clock. Wait once, then run the same strict verification
      // against fresh clocks. Never add leeway to expiry or extend the lease.
      if (!(error instanceof Error) || error.message !== 'REMOTE_PROOF_EXPIRED' || this.stopped) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
      if (this.stopped) throw new Error('REMOTE_SESSION_ENDED');
      return verify();
    }
  }
  private signalBinding() { return { negotiationId: this.options.binding.negotiationId, connectionGeneration: this.options.binding.controller.generation }; }
  private async sendHello() {
    if (this.helloSending || this.stopped || !this.connectionProof || this.stateChannel.readyState !== 'open' || this.now() >= this.connectDeadline) return;
    this.helloSending = true;
    const generation = this.proofGeneration;
    try {
      const transport = this.peer.sctp?.transport;
      if (!transport || transport.state !== 'connected' || typeof transport.getRemoteCertificates !== 'function') throw new Error('REMOTE_DTLS_CERTIFICATE_UNAVAILABLE');
      const certificate = transport.getRemoteCertificates()[0];
      if (!certificate) throw new Error('REMOTE_DTLS_CERTIFICATE_UNAVAILABLE');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', certificate));
      const fingerprint = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (this.stopped || generation !== this.proofGeneration) return;
      if (fingerprint !== this.connectionProof.claims.hostFingerprint || this.now() >= this.connectDeadline) throw new Error('REMOTE_DTLS_CERTIFICATE_MISMATCH');
      this.actualDtlsVerified = true;
      this.sendState('hello', { proof: this.connectionProof.envelope });
    } catch (error) { this.end(error instanceof Error ? error.message : 'REMOTE_DTLS_CERTIFICATE_INVALID'); }
    finally { this.helloSending = false; }
  }
  private sendState(type: string, payload: Record<string, unknown> = {}) {
    if (!this.connectionProof || this.stateChannel.readyState !== 'open') return false;
    const data = JSON.stringify({ version: 1, sessionId: this.options.binding.sessionId, negotiationId: this.options.binding.negotiationId, connectionGeneration: this.options.binding.controller.generation, type, payload });
    if (utf8Bytes(data) > 4096 || this.stateChannel.bufferedAmount + utf8Bytes(data) > 16384) { if (!this.stopped) this.end('REMOTE_STATE_BACKPRESSURE'); return false; }
    try { this.stateChannel.send(data); return true; } catch { if (!this.stopped) this.end('REMOTE_STATE_SEND_FAILED'); return false; }
  }
  private receiveState(raw: unknown) {
    if (this.stopped || !this.connectionProof || typeof raw !== 'string' || utf8Bytes(raw) > 4096) { if (!this.stopped) this.end('REMOTE_INVALID_STATE_MESSAGE'); return; }
    try {
      const message = JSON.parse(raw);
      if (message.version !== 1 || message.sessionId !== this.options.binding.sessionId || message.negotiationId !== this.options.binding.negotiationId || message.connectionGeneration !== this.options.binding.host.generation || !message.payload || typeof message.payload !== 'object') throw new Error('REMOTE_STATE_BINDING');
      const payload = message.payload;
      switch (message.type) {
        case 'hello':
          // The exact server-signed binding must be acknowledged by the peer.
          if (!this.actualDtlsVerified || payload.proofSignature !== this.connectionProof.envelope.signature || this.now() >= this.connectDeadline) throw new Error('REMOTE_HANDSHAKE_PROOF');
          this.helloReceived = true; this.lastHeartbeat = this.now();
          if (!this.readySent) { this.readySent = true; void Promise.resolve(this.options.onReady()).catch(() => this.end('REMOTE_READY_FAILED')); }
          break;
        case 'heartbeat': this.lastHeartbeat = this.now(); break;
        case 'layout': {
          const layout = parseRemoteControlLayout(payload);
          if (!this.lease || !layout || layout.screenId !== this.options.binding.screenId
            || Object.keys(message).length !== 6) throw new Error('REMOTE_LAYOUT_INVALID');
          if (this.layout && !sameRemoteControlLayout(this.layout, layout)) { this.end('REMOTE_LAYOUT_CHANGED'); return; }
          this.layout = layout;
          this.decodedGeometryReady();
          break;
        }
        case 'input-armed': {
          if (!this.decodedGeometryReady() || !this.lease || this.lease.claims.scope !== 'control' || this.now() >= this.lease.deadline || payload.requestId !== this.armRequest || this.armRequest === null || payload.controlEpoch !== this.lease.claims.controlEpoch || payload.layoutVersion !== this.layout?.layoutVersion || this.frozen) throw new Error('REMOTE_INPUT_ARM_INVALID');
          const context: RemoteInputContext = { sessionId: this.options.binding.sessionId, controlEpoch: payload.controlEpoch, inputEpoch: payload.inputEpoch, layoutVersion: payload.layoutVersion };
          this.armRequest = null;
          if (!this.input.arm(context)) throw new Error('REMOTE_INPUT_ARM_INVALID');
          break;
        }
        case 'input-window':
          if (!this.lease || !this.input.acceptWindow({ ...payload, sessionId: this.options.binding.sessionId })) this.pauseInput('REMOTE_INPUT_WINDOW_INVALID');
          else { this.options.onInputArmed?.(true); this.options.onInputWindow?.(); }
          break;
        case 'input-ack': if (!this.input.acknowledge({ ...payload, sessionId: this.options.binding.sessionId })) this.pauseInput('REMOTE_INPUT_ACK_INVALID'); break;
        case 'pause': {
          const wasArmed = this.input.armed;
          this.hostPaused = true; this.pauseInput('REMOTE_HOST_PAUSED');
          if (!wasArmed) this.options.onPauseInput('REMOTE_HOST_PAUSED');
          break;
        }
        case 'end': this.end('REMOTE_HOST_ENDED'); break;
        default: throw new Error('REMOTE_STATE_TYPE');
      }
    } catch (error) { this.end(error instanceof Error ? error.message : 'REMOTE_INVALID_STATE_MESSAGE'); }
  }
  private publishStream() {
    if (!this.lease || this.stopped || !this.stream.getVideoTracks().length) return;
    this.options.onStream(this.stream);
    if (this.video) {
      this.video.srcObject = this.stream;
      this.video.muted = true;
      void this.video.play().catch(() => this.pauseInput('REMOTE_VIDEO_PLAY_BLOCKED'));
      this.watchFrame();
    }
  }
  private watchFrame() {
    if (!this.video || this.stopped || this.videoCallback !== null || typeof this.video.requestVideoFrameCallback !== 'function') return;
    this.videoCallback = this.video.requestVideoFrameCallback(() => { this.videoCallback = null; this.frameRendered(); this.watchFrame(); });
  }
  private frameRendered() {
    if (this.layout && !this.decodedGeometryReady()) return;
    this.lastFrame = this.now(); this.frameCount++; this.frozen = false;
  }
  private tick() {
    if (this.stopped) return;
    const now = this.now();
    if (!this.lease && now >= this.connectDeadline) { this.end('REMOTE_CONNECT_TIMEOUT'); return; }
    // ICE/DTLS/hello negotiation uses the bounded connection deadline. Heartbeat
    // liveness begins only after the authenticated peer has acknowledged hello.
    if (this.helloReceived && now - this.lastHeartbeat >= 3000) { this.end('REMOTE_HEARTBEAT_TIMEOUT'); return; }
    // Certificate hashing is asynchronous. Wait for the host's hello receipt so
    // a periodic heartbeat can never overtake the authenticated handshake.
    if (this.helloReceived && now - this.lastHeartbeatSent >= 1000) { this.lastHeartbeatSent = now; this.sendState('heartbeat', { renderedFrames: this.frameCount }); }
    if (!this.lease) return;
    if (this.layout) { this.decodedGeometryReady(); if (this.stopped) return; }
    if (now >= this.lease.deadline) { this.end('REMOTE_LEASE_EXPIRED'); return; }
    if (this.video && typeof this.video.requestVideoFrameCallback !== 'function') {
      const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames || 0;
      if (frames > this.previousVideoFrames) { this.previousVideoFrames = frames; this.frameRendered(); }
    }
    if (now - this.lastFrame >= 10000) { this.end('REMOTE_VIDEO_FROZEN'); return; }
    if (now - this.lastFrame >= 3000 && !this.frozen) { this.frozen = true; this.pauseInput('REMOTE_VIDEO_STALLED'); this.options.onPauseInput('REMOTE_VIDEO_STALLED'); }
  }
  private async collectStats() {
    if (this.stopped || !this.lease) return;
    try {
      const report = await this.peer.getStats();
      if (this.stopped) return;
      let video: any = null; let pair: any = null;
      report.forEach(stat => { if (stat.type === 'inbound-rtp' && stat.kind === 'video') video = stat; if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) pair = stat; });
      if (!video) return;
      const elapsed = this.lastStats ? video.timestamp - this.lastStats.timestamp : 0;
      const bitrate = elapsed > 0 ? Math.max(0, (video.bytesReceived - this.lastStats!.bytes) * 8000 / elapsed) : 0;
      this.lastStats = { timestamp: video.timestamp, bytes: video.bytesReceived };
      const local = pair ? report.get(pair.localCandidateId) : null;
      this.options.onStats?.({ roundTripMs: typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null, framesPerSecond: video.framesPerSecond || 0, bitrate, packetsLost: video.packetsLost || 0, relay: local ? local.candidateType === 'relay' : null });
    } catch { if (!this.stopped) this.pauseInput('REMOTE_STATS_UNAVAILABLE'); }
  }
}
