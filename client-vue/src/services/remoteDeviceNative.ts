import { invoke, isTauri } from '@tauri-apps/api/core';
import type { RemoteDeviceChallenge, RemoteDeviceRegistration, RemoteIdentityChallenge, RemoteIdentityProof } from '@/api/remoteControl';
import type { NativeRemoteCapabilities } from './remoteControlCapabilities';
import type { RemoteSignedEnvelope } from './remoteControlProof';
import { registerRemoteControlCleanup } from './remoteControlSafety';

export interface RemoteDeviceSupport { desktop: boolean; registration: boolean; identification?: boolean; identityReset: boolean; consent: boolean; platform: string; }
let generation = 0;
let active = false;
let authorityMayExist = false;
let interrupt: (() => void) | null = null;
let stopping: Promise<void> = Promise.resolve();
const cancelled = () => new Error('REMOTE_OPERATION_CANCELLED');
const bounded = async <T>(task: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('REMOTE_NATIVE_TIMEOUT')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

/** No private keys, caller-supplied trust anchors, or accepted flags cross this bridge. */
export async function probeRemoteDeviceSupport(): Promise<RemoteDeviceSupport> {
  const result: RemoteDeviceSupport = { desktop: isTauri(), registration: false, identityReset: false, consent: false, platform: '' };
  if (!result.desktop) return result;
  try {
    const capability = await bounded(invoke<NativeRemoteCapabilities>('remote_control_capabilities'), 5000);
    if (capability.runtime === 'tauri' && capability.protocolVersion === 1 && ['macos', 'windows'].includes(capability.platform)) {
      result.platform = capability.platform;
      result.registration = capability.deviceRegistrationReady === true;
      result.identityReset = capability.deviceIdentityResetReady === true;
      result.identification = capability.deviceIdentificationReady === true;
      result.consent = capability.consentPromptReady === true;
    }
  } catch { /* Older clients and unavailable OS credential stores remain unavailable. */ }
  return result;
}

export function cancelRemoteNativeOperation() {
  generation++;
  const notify = interrupt; interrupt = null; notify?.();
  if (!isTauri() || (!active && !authorityMayExist)) return stopping;
  active = false; authorityMayExist = false;
  // Start stop immediately, then prevent another command from overtaking it.
  stopping = bounded(invoke<void>('remote_control_stop'), 1500);
  void stopping.catch(() => {});
  return stopping;
}
registerRemoteControlCleanup(() => { void cancelRemoteNativeOperation().catch(() => {}); });

async function operation<T>(command: string, args: Record<string, unknown>, signal: AbortSignal, timeout: number): Promise<T> {
  if (!isTauri()) throw new Error('REMOTE_DESKTOP_REQUIRED');
  if (active) throw new Error('REMOTE_NATIVE_BUSY');
  const current = generation;
  signal.throwIfAborted();
  active = true;
  let rejectCancelled!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const rejectOperation = () => rejectCancelled(cancelled());
  interrupt = rejectOperation;
  const cancel = () => { void cancelRemoteNativeOperation().catch(() => {}); rejectCancelled(cancelled()); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await Promise.race([stopping, aborted]);
    if (current !== generation || signal.aborted) throw cancelled();
    const value = await bounded(Promise.race([invoke<T>(command, args), aborted]), timeout);
    if (current !== generation || signal.aborted) throw cancelled();
    return value;
  } catch (error) {
    if (current === generation) void cancelRemoteNativeOperation().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (interrupt === rejectOperation) interrupt = null;
    if (current === generation) active = false;
  }
}

export function validDeviceChallenge(value: RemoteDeviceChallenge, userId: number, sid: string) {
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  return value && Object.keys(value).every(key => ['id', 'nonce', 'userId', 'sid', 'action', 'expiresAt'].includes(key))
    && uuid.test(value.id) && value.userId === userId && value.sid === sid && uuid.test(value.sid)
    && value.action === 'register-device' && /^[A-Za-z0-9_-]{43}$/.test(value.nonce)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 30000;
}

export async function createRemoteDeviceProof(challenge: RemoteDeviceChallenge, alias: string, signal: AbortSignal) {
  const value = await operation<RemoteDeviceRegistration>('remote_control_register_device', { challenge, alias }, signal, Math.max(1, challenge.expiresAt - Date.now()));
  if (!value || Object.keys(value).some(key => !['challengeId', 'publicKey', 'signature', 'alias', 'platform'].includes(key))
    || value.challengeId !== challenge.id || value.alias !== alias || !['macos', 'windows'].includes(value.platform)
    || typeof value.publicKey !== 'string' || value.publicKey.length > 1024 || !value.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)
    || challenge.expiresAt <= Date.now()) throw new Error('REMOTE_DEVICE_PROOF_INVALID');
  return value;
}

function envelope(value: RemoteSignedEnvelope) {
  return value && Object.keys(value).every(key => ['format', 'keyId', 'payload', 'signature'].includes(key))
    && value.format === 'rc-signed-v1' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.keyId)
    && typeof value.payload === 'string' && value.payload.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(value.payload)
    && /^[A-Za-z0-9_-]{86}$/.test(value.signature);
}

/** A transport may pass a server-signed request; only the OS prompt can choose its decision. */
export async function confirmRemoteNativeRequest(request: RemoteSignedEnvelope, signal: AbortSignal): Promise<RemoteSignedEnvelope> {
  if (!envelope(request)) throw new Error('REMOTE_REQUEST_INVALID');
  const current = generation;
  const result = await operation<{ consent: RemoteSignedEnvelope }>('remote_control_confirm_request', { request }, signal, 45000);
  if (current !== generation || signal.aborted) throw cancelled();
  authorityMayExist = true;
  if (!result || Object.keys(result).length !== 1 || !envelope(result.consent)) {
    void cancelRemoteNativeOperation().catch(() => {});
    throw new Error('REMOTE_CONSENT_INVALID');
  }
  return result.consent;
}

/** Identity rotation requires an independent OS confirmation and never registers automatically. */
export async function resetRemoteDeviceIdentity(userId: number, signal: AbortSignal): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('REMOTE_AUTH_REQUIRED');
  const result = await operation<{ reset: boolean }>('remote_control_reset_identity', { userId }, signal, 45000);
  if (!result || Object.keys(result).length !== 1 || typeof result.reset !== 'boolean') throw new Error('REMOTE_RESET_INVALID');
  return result.reset;
}

export function validIdentityChallenge(value: RemoteIdentityChallenge, userId: number, sid: string) {
  return value?.action === 'identify-device' && validDeviceChallenge({ ...value, action: 'register-device' }, userId, sid);
}
export async function identifyRemoteDevice(challenge: RemoteIdentityChallenge, signal: AbortSignal) {
  const value = await operation<RemoteIdentityProof>('remote_control_identify_device', { challenge }, signal, Math.max(1, challenge.expiresAt - Date.now()));
  if (!value || Object.keys(value).some(key => !['challengeId', 'publicKey', 'signature', 'platform'].includes(key))
    || value.challengeId !== challenge.id || !['macos', 'windows'].includes(value.platform)
    || typeof value.publicKey !== 'string' || value.publicKey.length > 1024 || !value.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)
    || challenge.expiresAt <= Date.now()) throw new Error('REMOTE_DEVICE_PROOF_INVALID');
  return value;
}
