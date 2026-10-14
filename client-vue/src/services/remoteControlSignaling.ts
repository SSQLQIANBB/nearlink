import { createRequestId } from '@/utils/requestId';
import { registerRemoteControlCleanup } from './remoteControlSafety';

export interface RemoteStateSnapshot {
  sessionId: string;
  state: 'pending' | 'connecting' | 'active' | 'ended';
  revision: number;
  scope: 'view' | 'control';
  authorizationRevision: number;
  controlEpoch: number;
}
export interface RemoteSignalAck {
  ok: boolean;
  code?: string;
  sessionId?: string;
  revision?: number;
  state?: RemoteStateSnapshot['state'];
}
export interface RemoteSignalEnvelope {
  protocolVersion: 1;
  requestId: string;
  sessionId?: string;
  expectedRevision?: number;
  connectionGeneration: number;
  payload: Record<string, unknown>;
}
export type ControllerRemoteCommand =
  | 'remote:request'
  | 'remote:cancel'
  | 'remote:signal'
  | 'remote:ready'
  | 'remote:control-request'
  | 'remote:pause'
  | 'remote:input-arm'
  | 'remote:lease'
  | 'remote:end';
export interface RemoteSignalTransport {
  readonly connected: boolean;
  emit(
    event: string,
    envelope: RemoteSignalEnvelope,
    acknowledge: (value: unknown) => void,
  ): unknown;
  disconnect(): unknown;
}
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isState = (value: unknown): value is RemoteStateSnapshot['state'] =>
  ['pending', 'connecting', 'active', 'ended'].includes(value as string);

function validAck(value: unknown): value is RemoteSignalAck {
  if (!value || typeof value !== 'object') return false;
  const ack = value as RemoteSignalAck;
  return (
    typeof ack.ok === 'boolean' &&
    (ack.code === undefined || typeof ack.code === 'string') &&
    (ack.sessionId === undefined || typeof ack.sessionId === 'string') &&
    (ack.revision === undefined || integer(ack.revision)) &&
    (ack.state === undefined || isState(ack.state))
  );
}

/**
 * Bounded command transport for the future native-media integration. It does not
 * open a Socket, issue consent, install a lease, or arm controller input.
 * Use namespace /remote-control, path /meeting, reconnection:false and authenticated
 * { token, controllerInstanceId, platform, role:'controller' } when integrating.
 */
export class RemoteSignalClient {
  private ended = false;
  private sessionId: string | null = null;
  private snapshot: RemoteStateSnapshot | null = null;
  private revision: number | null = null;
  private pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }
  >();
  private readonly unregisterCleanup: () => void;

  constructor(
    private readonly transport: RemoteSignalTransport,
    private readonly connectionGeneration: number,
    private readonly onStop: (reason: string) => void,
    private readonly onState: (state: RemoteStateSnapshot) => void,
    private readonly timeoutMs = 5000,
  ) {
    if (
      !integer(connectionGeneration) ||
      connectionGeneration === 0 ||
      timeoutMs <= 0 ||
      timeoutMs > 10000
    )
      throw new Error('REMOTE_INVALID_CONFIGURATION');
    this.unregisterCleanup = registerRemoteControlCleanup((reason) => this.invalidate(reason));
  }

  command(
    event: ControllerRemoteCommand,
    payload: Record<string, unknown>,
    requestId = createRequestId(),
  ): Promise<RemoteSignalAck> {
    if (this.ended || !this.transport.connected)
      return Promise.reject(new Error('REMOTE_DISCONNECTED'));
    if (this.pending.has(requestId)) return Promise.reject(new Error('REMOTE_REQUEST_PENDING'));
    if (event !== 'remote:request' && !this.sessionId)
      return Promise.reject(new Error('REMOTE_SESSION_REQUIRED'));
    if (event !== 'remote:request' && this.revision === null)
      return Promise.reject(new Error('REMOTE_REVISION_REQUIRED'));
    if (event === 'remote:request' && (this.sessionId || this.pending.size > 0))
      return Promise.reject(new Error('REMOTE_SESSION_BUSY'));
    const envelope: RemoteSignalEnvelope = {
      protocolVersion: 1,
      requestId,
      connectionGeneration: this.connectionGeneration,
      payload,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.revision !== null ? { expectedRevision: this.revision } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.invalidate('REMOTE_ACK_TIMEOUT'), this.timeoutMs);
      this.pending.set(requestId, { timer, reject });
      const finish = (raw: unknown) => {
        if (this.ended || !this.pending.has(requestId)) return;
        if (!validAck(raw)) {
          this.invalidate('REMOTE_INVALID_ACK');
          return;
        }
        if (raw.sessionId && this.sessionId && raw.sessionId !== this.sessionId) {
          this.invalidate('REMOTE_SESSION_MISMATCH');
          return;
        }
        if (
          raw.ok &&
          (raw.revision === undefined || (event === 'remote:request' && !raw.sessionId))
        ) {
          this.invalidate('REMOTE_INVALID_ACK');
          return;
        }
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (!raw.ok) {
          const code = raw.code || 'REMOTE_REQUEST_REJECTED';
          reject(new Error(code));
          if (
            [
              'AUTH_REVOKED',
              'LEASE_EXPIRED',
              'SESSION_ENDED',
              'NATIVE_VALIDATION_PENDING',
              'REVISION_CONFLICT',
            ].includes(code)
          )
            this.invalidate(code);
          return;
        }
        if (raw.sessionId) this.sessionId = raw.sessionId;
        if (raw.revision !== undefined) this.revision = Math.max(this.revision ?? 0, raw.revision);
        // ACK reports acceptance only. It can never grant media/input authority.
        resolve(raw);
        if (raw.state === 'ended' || event === 'remote:end') this.invalidate('SESSION_ENDED');
      };
      try {
        this.transport.emit(event, envelope, finish);
      } catch {
        this.invalidate('REMOTE_SEND_FAILED');
      }
    });
  }

  receiveState(value: unknown) {
    if (this.ended || !value || typeof value !== 'object') return false;
    const state = value as RemoteStateSnapshot;
    if (!this.sessionId || state.sessionId !== this.sessionId) return false;
    if (
      !isState(state.state) ||
      !integer(state.revision) ||
      !integer(state.authorizationRevision) ||
      !integer(state.controlEpoch) ||
      !['view', 'control'].includes(state.scope)
    ) {
      this.invalidate('REMOTE_INVALID_STATE');
      return false;
    }
    const previous = this.snapshot;
    if (
      (this.revision !== null && state.revision < this.revision) ||
      (previous && state.revision <= previous.revision)
    )
      return false;
    const order = { pending: 0, connecting: 1, active: 2, ended: 3 };
    if (previous && order[state.state] < order[previous.state]) {
      this.invalidate('REMOTE_STATE_ROLLBACK');
      return false;
    }
    if (
      previous &&
      (state.authorizationRevision < previous.authorizationRevision ||
        state.controlEpoch < previous.controlEpoch)
    ) {
      this.invalidate('REMOTE_AUTHORIZATION_ROLLBACK');
      return false;
    }
    this.snapshot = { ...state };
    this.revision = state.revision;
    // A state update still lacks the signed lease and native consent needed to arm input.
    this.onState({ ...state });
    if (state.state === 'ended') this.invalidate('SESSION_ENDED');
    return true;
  }

  invalidate(reason: string) {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    try {
      this.onStop(reason);
    } finally {
      this.transport.disconnect();
      this.unregisterCleanup();
    }
  }
}
