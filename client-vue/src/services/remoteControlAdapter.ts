import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '@/config/env';
import { createRequestId } from '@/utils/requestId';
import { RemoteSignalClient, type RemoteStateSnapshot } from './remoteControlSignaling';
import type { RemoteEndpointIdentity, RemoteSignedEnvelope } from './remoteControlProof';
import type { RemotePeerSignal, RemoteControlApproval } from './remoteControlPeer';

export interface RemoteConnecting {
  sessionId: string; revision: number; authorizationRevision: number; controlEpoch: number; scope: 'view' | 'control';
  host: RemoteEndpointIdentity; controller: RemoteEndpointIdentity; consentNonce: string;
  screenId: string; negotiationId: string; hardDeadline: number;
}
export type RemoteControllerEvent = { type: 'device-verified'; deviceId: string } | { type: 'connecting'; value: RemoteConnecting }
  | { type: 'signal'; value: RemotePeerSignal }
  | { type: 'connection-proof' | 'lease'; value: RemoteSignedEnvelope }
  | { type: 'state'; value: RemoteStateSnapshot }
  | { type: 'control-approved'; value: RemoteControlApproval }
  | { type: 'ended'; reason: string };
export interface RemoteControllerAdapter {
  request(targetDeviceId: string, scope: 'view' | 'control'): Promise<string>;
  signal(signal: RemotePeerSignal): Promise<void>;
  ready(binding: { negotiationId: string; hostFingerprint: string; controllerFingerprint: string }): Promise<void>;
  pause(): Promise<void>;
  requestControl(): Promise<void>;
  end(reason: string): Promise<void>;
  dispose(): void;
}
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function endpoint(value: unknown): value is RemoteEndpointIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as RemoteEndpointIdentity;
  return exactKeys(item, ['userId', 'sid', 'authVersion', 'endpointId', 'connectionId', 'generation']) && isInteger(item.userId) && item.userId > 0 && isInteger(item.generation) && item.generation > 0 && isId(item.sid) && isId(item.authVersion) && isId(item.endpointId) && typeof item.connectionId === 'string' && item.connectionId.length > 0 && item.connectionId.length <= 128;
}
function exactKeys(value: object, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)); }
export function validRemoteConnecting(value: unknown): value is RemoteConnecting {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['sessionId', 'revision', 'authorizationRevision', 'controlEpoch', 'scope', 'host', 'controller', 'consentNonce', 'screenId', 'negotiationId', 'hardDeadline'])) return false;
  const item = value as RemoteConnecting;
  return isId(item.sessionId) && isId(item.negotiationId) && endpoint(item.host) && endpoint(item.controller)
    && [item.revision, item.authorizationRevision, item.controlEpoch, item.hardDeadline].every(isInteger)
    && ['view', 'control'].includes(item.scope) && /^[A-Za-z0-9_-]{43}$/.test(item.consentNonce)
    && typeof item.screenId === 'string' && item.screenId.length > 0 && item.screenId.length <= 128;
}

export interface ControllerDeviceBinding {
  deviceId: string;
  prove(challenge: RemoteSignedEnvelope, expected: { controller: RemoteEndpointIdentity; deviceId: string }, signal: AbortSignal): Promise<RemoteSignedEnvelope>;
}
/** Production adapter; constructing it does not connect. The release gate is enforced by the store and server. */
export class SocketRemoteControllerAdapter implements RemoteControllerAdapter {
  private readonly socket: Socket;
  private readonly signaling: RemoteSignalClient;
  private sessionId: string | null = null;
  private state: RemoteStateSnapshot | null = null;
  private target: string | null = null;
  private closed = false;
  private eventQueue: Array<() => void> = [];
  private queuedBytes = 0;
  private connectReject: (() => void) | null = null;
  private readonly bindingAbort = new AbortController();
  private tokenDeadline: ReturnType<typeof setTimeout>;
  private readonly instanceId = createRequestId();
  private readonly identity: { userId: number; sid: string; authVersion: string; exp: number };

  constructor(token: string, platform: 'web' | 'windows' | 'macos', private readonly event: (event: RemoteControllerEvent) => void, private readonly deviceBinding?: ControllerDeviceBinding) {
    // Parsing is only a consistency check. The namespace authenticates this token independently.
    try { this.identity = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))); }
    catch { throw new Error('REMOTE_AUTH_REQUIRED'); }
    if (!this.identity || !isInteger(this.identity.userId) || !isId(this.identity.sid) || !isId(this.identity.authVersion) || !isInteger(this.identity.exp) || this.identity.exp * 1000 <= Date.now()) throw new Error('REMOTE_AUTH_REQUIRED');
    if (deviceBinding && (platform === 'web' || !isId(deviceBinding.deviceId))) throw new Error('REMOTE_CONTROLLER_DEVICE_INVALID');
    this.socket = io(`${publicEnv.socketUrl}/remote-control`, { path: '/meeting', transports: ['websocket'], autoConnect: false, reconnection: false, auth: { token, controllerInstanceId: this.instanceId, platform, role: 'controller', ...(deviceBinding ? { controllerDeviceId: deviceBinding.deviceId } : {}) } });
    this.signaling = new RemoteSignalClient(this.socket, 1, reason => this.stop(reason), value => { this.state = value; this.event({ type: 'state', value }); });
    this.socket.on('disconnect', () => this.stop('REMOTE_DISCONNECTED'));
    this.socket.on('remote:state', value => this.deliver(value, () => this.signaling.receiveState(value)));
    this.socket.on('remote:connecting', value => this.deliver(value, () => {
      if (!validRemoteConnecting(value) || value.sessionId !== this.sessionId || value.host.endpointId !== this.target
        || value.controller.userId !== this.identity.userId || value.controller.sid !== this.identity.sid || value.controller.authVersion !== this.identity.authVersion
        || value.controller.endpointId !== this.instanceId || value.controller.connectionId !== this.socket.id || value.controller.generation !== 1
        || (this.state && (value.revision < this.state.revision || !['pending', 'connecting'].includes(this.state.state) || value.authorizationRevision < this.state.authorizationRevision || value.controlEpoch < this.state.controlEpoch))
        || value.hardDeadline <= Date.now() || value.hardDeadline > Date.now() + 60 * 60 * 1000) { this.stop('REMOTE_CONNECTING_INVALID'); return; }
      this.signaling.receiveState({ sessionId: value.sessionId, state: 'connecting', revision: value.revision, scope: value.scope, authorizationRevision: value.authorizationRevision, controlEpoch: value.controlEpoch });
      this.event({ type: 'connecting', value });
    }));
    this.socket.on('remote:signal', value => this.deliver(value, () => {
      if (!value || value.sessionId !== this.sessionId || !exactKeys(value, ['sessionId', 'negotiationId', 'connectionGeneration', 'type', 'sdp', 'candidate']) || !isId(value.negotiationId) || !isInteger(value.connectionGeneration) || value.connectionGeneration < 1) { this.stop('REMOTE_SIGNAL_INVALID'); return; }
      if (value.type === 'answer' && typeof value.sdp === 'string' && new TextEncoder().encode(value.sdp).length <= 65536) this.event({ type: 'signal', value });
      else if (value.type === 'candidate' && value.candidate && typeof value.candidate.candidate === 'string' && new TextEncoder().encode(JSON.stringify(value.candidate)).length <= 4096) this.event({ type: 'signal', value });
      else this.stop('REMOTE_SIGNAL_INVALID');
    }));
    for (const type of ['connection-proof', 'lease'] as const) this.socket.on(`remote:${type}`, value => this.deliver(value, () => {
      if (!value || value.sessionId !== this.sessionId || !exactKeys(value, ['sessionId', 'proof'])) { this.stop('REMOTE_PROOF_EVENT_INVALID'); return; }
      this.event({ type, value: value.proof });
    }));
    this.socket.on('remote:control-approved', value => this.deliver(value, () => {
      if (!value || value.sessionId !== this.sessionId || !exactKeys(value, ['sessionId', 'host', 'controller', 'consentNonce', 'screenId', 'negotiationId', 'authorizationRevision', 'controlEpoch']) || !endpoint(value.host) || !endpoint(value.controller)) { this.stop('REMOTE_APPROVAL_INVALID'); return; }
      this.event({ type: 'control-approved', value });
    }));
    this.socket.on('remote:ended', value => this.deliver(value, () => { if (value?.sessionId === this.sessionId) this.stop('REMOTE_SESSION_ENDED'); }));
    this.tokenDeadline = setTimeout(() => this.stop('REMOTE_AUTH_EXPIRED'), Math.min(2147483647, this.identity.exp * 1000 - Date.now()));
  }

  async request(targetDeviceId: string, scope: 'view' | 'control') {
    if (this.closed || this.target || !isId(targetDeviceId)) throw new Error('REMOTE_REQUEST_INVALID');
    this.target = targetDeviceId;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { finish(); this.stop('REMOTE_CONNECT_TIMEOUT'); reject(new Error('REMOTE_CONNECT_TIMEOUT')); }, 5000);
      const connected = () => { finish(); resolve(); };
      const failed = () => { finish(); this.stop('REMOTE_CONNECT_REJECTED'); reject(new Error('REMOTE_CONNECT_REJECTED')); };
      const finish = () => { clearTimeout(timer); this.connectReject = null; this.socket.off('connect', connected); this.socket.off('connect_error', failed); };
      this.connectReject = () => { finish(); reject(new Error('REMOTE_DISCONNECTED')); };
      this.socket.once('connect', connected); this.socket.once('connect_error', failed); this.socket.connect();
    });
    if (this.closed) throw new Error('REMOTE_DISCONNECTED');
    if (this.deviceBinding) {
      try {
        const { proof } = await this.bindingCommand('remote:controller-challenge', {});
        const controller = { userId: this.identity.userId, sid: this.identity.sid, authVersion: this.identity.authVersion,
          endpointId: this.instanceId, connectionId: this.socket.id!, generation: 1 };
        const signed = await this.deviceBinding.prove(proof, { controller, deviceId: this.deviceBinding.deviceId }, this.bindingAbort.signal);
        if (this.closed) throw new Error('REMOTE_DISCONNECTED');
        await this.bindingCommand('remote:controller-proof', { proof: signed });
        this.event({ type: 'device-verified', deviceId: this.deviceBinding.deviceId });
      } catch (error) { this.stop('REMOTE_CONTROLLER_DEVICE_REJECTED'); throw error; }
    }
    const ack = await this.signaling.command('remote:request', { targetDeviceId, scope });
    this.sessionId = ack.sessionId!;
    for (const deliver of this.eventQueue.splice(0)) { if (!this.closed) deliver(); }
    this.queuedBytes = 0;
    return this.sessionId;
  }
  private bindingCommand(event: string, value: object): Promise<{ proof?: any }> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('REMOTE_DISCONNECTED')); return; }
      const finish = () => { clearTimeout(timer); this.bindingAbort.signal.removeEventListener('abort', aborted); };
      const aborted = () => { finish(); reject(new Error('REMOTE_DISCONNECTED')); };
      const timer = setTimeout(() => { finish(); reject(new Error('REMOTE_CONTROLLER_DEVICE_TIMEOUT')); }, 5000);
      this.bindingAbort.signal.addEventListener('abort', aborted, { once: true });
      this.socket.emit(event, value, (result: any) => {
        finish();
        if (this.closed || result?.ok !== true || (event === 'remote:controller-challenge' && !result.proof)) reject(new Error('REMOTE_CONTROLLER_DEVICE_REJECTED'));
        else resolve(result);
      });
    });
  }
  async signal(signal: RemotePeerSignal) { await this.signaling.command('remote:signal', signal); }
  async ready(binding: { negotiationId: string; hostFingerprint: string; controllerFingerprint: string }) { await this.signaling.command('remote:ready', binding); }
  async pause() { await this.signaling.command('remote:pause', {}); }
  async requestControl() { await this.signaling.command('remote:control-request', {}); }
  async end(reason: string) {
    try { if (this.sessionId && !this.closed) await this.signaling.command('remote:end', { reason }); }
    finally { this.dispose(); }
  }
  dispose() { this.stop('REMOTE_LOCAL_END'); }
  private deliver(value: unknown, callback: () => void) {
    if (this.closed) return;
    const size = new TextEncoder().encode(JSON.stringify(value) || '').length;
    if (size > 70000) { this.stop('REMOTE_EVENT_LIMIT'); return; }
    if (this.sessionId) { callback(); return; }
    if (!this.target || this.eventQueue.length >= 8 || this.queuedBytes + size > 70000) { this.stop('REMOTE_EVENT_LIMIT'); return; }
    this.queuedBytes += size; this.eventQueue.push(callback);
  }
  private stop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.bindingAbort.abort();
    this.connectReject?.();
    clearTimeout(this.tokenDeadline);
    this.eventQueue = []; this.queuedBytes = 0;
    this.socket.removeAllListeners();
    this.signaling.invalidate(reason);
    this.socket.disconnect();
    this.event({ type: 'ended', reason });
  }
}
