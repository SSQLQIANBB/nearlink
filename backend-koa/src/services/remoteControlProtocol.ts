import { createHash } from 'crypto';
import { z } from 'zod';

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_LIMITS = Object.freeze({
  requestMs: 45_000,
  connectMs: 30_000,
  sessionMs: 60 * 60_000,
  leaseMs: 15_000,
  tombstoneMs: 10 * 60_000,
  challengeMs: 30_000,
  grantMs: 15 * 60_000,
  presenceMs: 30_000,
});
export class RemoteControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
export const uuid = z.string().uuid();
export const positiveId = z.number().int().positive().safe();
export const scopeSchema = z.enum(['view', 'control']);
export type RemoteScope = z.infer<typeof scopeSchema>;
export const envelopeSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    requestId: uuid,
    sessionId: uuid.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    connectionGeneration: z.number().int().positive(),
    payload: z.unknown(),
  })
  .strict();

export type RemoteEndpoint = {
  userId: number;
  sid: string;
  authVersion: string;
  endpointId: string;
  connectionId: string;
  generation: number;
};
export type RemoteSession = {
  id: string;
  requestId: string;
  requestHash: string;
  grantId: string;
  grantCreatedBySid?: string;
  controller: RemoteEndpoint;
  host: RemoteEndpoint;
  requestedScope: RemoteScope;
  scope: RemoteScope;
  state: 'pending' | 'connecting' | 'active' | 'ended';
  revision: number;
  authorizationRevision: number;
  controlEpoch: number;
  controllerReady: boolean;
  hostReady: boolean;
  createdAt: number;
  deadline: number;
  hardDeadline: number;
  endedAt?: number;
  reason?: string;
};

/** Hash structured, validated inputs; caller ordering must not alter idempotency. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const remoteDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export function isEndpoint(expected: RemoteEndpoint, actual: RemoteEndpoint) {
  return (
    expected.userId === actual.userId &&
    expected.sid === actual.sid &&
    expected.authVersion === actual.authVersion &&
    expected.endpointId === actual.endpointId &&
    expected.connectionId === actual.connectionId &&
    expected.generation === actual.generation
  );
}

export type RemoteAction =
  | { type: 'respond'; accepted: boolean; scope: RemoteScope }
  | { type: 'ready' }
  | { type: 'pause' }
  | { type: 'grant-control' }
  | { type: 'cancel' }
  | { type: 'end'; reason?: string };

/** Pure authority/state reducer. Native consent and authenticated transport remain prerequisites. */
export function transitionRemoteSession(
  current: RemoteSession,
  actor: RemoteEndpoint,
  action: RemoteAction,
  now: number,
): RemoteSession {
  const host = isEndpoint(current.host, actor);
  const controller = isEndpoint(current.controller, actor);
  if (!host && !controller) throw new RemoteControlError('NOT_A_PARTICIPANT', 403);
  if (current.state === 'ended') {
    if (action.type === 'end' || action.type === 'cancel') return current;
    throw new RemoteControlError('SESSION_ENDED');
  }
  if (now >= current.deadline || now >= current.hardDeadline)
    return endRemoteSession(current, 'EXPIRED', now);
  const next = { ...current, revision: current.revision + 1 };
  switch (action.type) {
    case 'respond':
      if (!host || current.state !== 'pending') throw new RemoteControlError('INVALID_TRANSITION');
      if (!action.accepted) return endRemoteSession(current, 'REJECTED', now);
      if (action.scope === 'control' && current.requestedScope !== 'control')
        throw new RemoteControlError('SCOPE_ESCALATION', 403);
      return {
        ...next,
        scope: action.scope,
        authorizationRevision: current.authorizationRevision + 1,
        controlEpoch: current.controlEpoch + 1,
        state: 'connecting',
        deadline: Math.min(now + REMOTE_LIMITS.connectMs, current.hardDeadline),
      };
    case 'ready':
      if (current.state !== 'connecting') throw new RemoteControlError('INVALID_TRANSITION');
      next.hostReady ||= host;
      next.controllerReady ||= controller;
      if (next.hostReady && next.controllerReady) {
        next.state = 'active';
        next.deadline = current.hardDeadline;
      }
      return next;
    case 'pause':
      if (current.state !== 'active') throw new RemoteControlError('INVALID_TRANSITION');
      return {
        ...next,
        scope: 'view',
        authorizationRevision: current.authorizationRevision + 1,
        controlEpoch: current.controlEpoch + 1,
      };
    case 'grant-control':
      if (!host || current.state !== 'active' || current.scope !== 'view')
        throw new RemoteControlError('INVALID_TRANSITION');
      return {
        ...next,
        scope: 'control',
        authorizationRevision: current.authorizationRevision + 1,
        controlEpoch: current.controlEpoch + 1,
      };
    case 'cancel':
      if (!controller || !['pending', 'connecting'].includes(current.state))
        throw new RemoteControlError('INVALID_TRANSITION');
      return endRemoteSession(current, 'CANCELLED', now);
    case 'end':
      return endRemoteSession(current, action.reason || 'ENDED', now);
  }
}

export function endRemoteSession(
  current: RemoteSession,
  reason: string,
  now: number,
): RemoteSession {
  if (current.state === 'ended') return current;
  return {
    ...current,
    state: 'ended',
    revision: current.revision + 1,
    authorizationRevision: current.authorizationRevision + 1,
    controlEpoch: current.controlEpoch + 1,
    endedAt: now,
    deadline: now,
    reason,
  };
}
