import { activeAssistanceWhere } from '../services/assistanceGrantPolicy';
import type { Server, Socket } from 'socket.io';
import { Op } from 'sequelize';
import { z } from 'zod';
import { AssistanceGrant } from '../models/RemoteControl';
import { getRemoteControlCapabilities } from '../services/remoteControlPolicy';
import { getRemoteControlContext } from '../services/remoteControlContext';
import { envelopeSchema, uuid, isEndpoint, RemoteControlError, type RemoteSession } from '../services/remoteControlProtocol';
import type { LiveConnection } from '../services/remoteLiveAuthority';
import { validateAuthenticatedSession } from '../services/loginSessionService';

const handshake = z.discriminatedUnion('role', [
  z.object({ token: z.string().min(1).max(8192), role: z.literal('controller'), platform: z.enum(['web', 'macos', 'windows']), controllerInstanceId: uuid }).strict(),
  z.object({ token: z.string().min(1).max(8192), role: z.literal('host'), platform: z.literal('macos'), deviceId: uuid }).strict(),
]);
const signalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['offer', 'answer']), negotiationId: uuid, connectionGeneration: z.literal(1), sdp: z.string().max(65536) }).strict(),
  z.object({ type: z.literal('candidate'), negotiationId: uuid, connectionGeneration: z.literal(1), candidate: z.object({
    candidate: z.string().max(2048), sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(16).nullable().optional(), usernameFragment: z.string().max(256).nullable().optional(),
  }).strict() }).strict(),
]);
const empty = z.object({}).strict();
const snapshot = (s: RemoteSession) => ({ sessionId: s.id, state: s.state, revision: s.revision,
  scope: s.scope, authorizationRevision: s.authorizationRevision, controlEpoch: s.controlEpoch });
const fail = (code: string): never => { throw new RemoteControlError(code); };

/** Dedicated namespace, authenticated native presence, bounded signaling, and durable admission. */
export function initializeRemoteControl(io: Server) {
  const namespace = io.of('/remote-control');
  const { authority, coordinator, service, store, history } = getRemoteControlContext();
  const sessionsBySocket = new Map<string, string>();
  const sessions = new Map<string, RemoteSession>();
  const queues = new Map<string, { tail: Promise<unknown>; pending: number }>();
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const queue = queues.get(id) || { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 32) return Promise.reject(new RemoteControlError('REMOTE_BACKPRESSURE', 429));
    queues.set(id, queue); queue.pending++;
    const task = queue.tail.catch(() => {}).then(action);
    queue.tail = task.finally(() => { if (--queue.pending === 0) queues.delete(id); }).catch(() => {});
    return task;
  }
  function emit(s: RemoteSession, event: string, value: unknown) {
    namespace.to(s.host.connectionId).to(s.controller.connectionId).emit(event, value);
  }
  const unsubscribe = service.subscribe(s => {
    emit(s, 'remote:state', snapshot(s));
    if (s.state === 'ended') {
      emit(s, 'remote:ended', { sessionId: s.id });
      for (const id of [s.host.connectionId, s.controller.connectionId]) {
        if (sessionsBySocket.get(id) === s.id) sessionsBySocket.delete(id);
      }
      sessions.delete(s.id); authority?.forget(s.id);
      void coordinator?.forgetEnded(s.id).catch(() => {});
    } else {
      sessions.set(s.id, s);
      sessionsBySocket.set(s.host.connectionId, s.id); sessionsBySocket.set(s.controller.connectionId, s.id);
    }
  });
  io.engine.once('close', unsubscribe);
  namespace.use(async (socket, next) => {
    let connection: LiveConnection | undefined;
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') fail('AUTH_REVOKED');
      const authenticated = await validateAuthenticatedSession(token);
      const policy = getRemoteControlCapabilities(authenticated.userId);
      if (!authority || !coordinator) fail(policy.reason);
      const input = handshake.parse(socket.handshake.auth);
      if (!authority || !coordinator || (input.role === 'host' ? !policy.desktopHostEnabled
        : input.platform === 'web' ? !policy.webControllerReleaseEnabled
          : !policy.desktopControllerEnabled || !policy.releasedPlatforms.includes(input.platform))) fail(policy.reason);
      connection = await authority!.connect(input.token, socket.id,
        input.role === 'host' ? input.deviceId : input.controllerInstanceId, input.role, input.platform);
      socket.data.remote = connection;
      // Engine close may race asynchronous authentication before Socket connection is established.
      if (socket.conn.readyState !== 'open') { authority!.disconnect(connection); return; }
      next();
    } catch (error) {
      if (connection) authority?.disconnect(connection);
      const code = error instanceof RemoteControlError ? error.code : 'AUTH_REVOKED';
      next(Object.assign(new Error(code), { data: { code } }));
    }
  });
  namespace.on('connection', socket => {
    const connection = socket.data.remote as LiveConnection;
    let pending = 0, commands = 0, windowAt = Date.now();
    const connectedAt = Date.now();
    const deadline = setTimeout(() => socket.disconnect(true), Math.max(1, connection.expiresAt - Date.now()));
    const presence = connection.role === 'host' ? setInterval(() => {
      if ((!connection.presence && Date.now() - connectedAt >= 30_000) || (connection.presence && connection.presence.expiresAt <= Date.now())) { socket.disconnect(true); return; }
      void authority!.presenceChallenge(connection).then(proof => socket.emit('remote:presence-challenge', { proof }))
        .catch(() => socket.disconnect(true));
    }, 10_000) : undefined;
    deadline.unref(); presence?.unref();
    if (connection.role === 'host') void authority!.presenceChallenge(connection)
      .then(proof => socket.emit('remote:presence-challenge', { proof })).catch(() => socket.disconnect(true));
    socket.on('disconnect', () => {
      clearTimeout(deadline); clearInterval(presence);
      authority!.disconnect(connection);
      const sessionId = sessionsBySocket.get(socket.id);
      if (sessionId) void service.end(sessionId, 'ENDPOINT_DISCONNECTED').catch(() => {});
    });
    socket.on('remote:presence', async (value: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (pending >= 2) { ack({ ok: false, code: 'REMOTE_BACKPRESSURE' }); return; }
      pending++;
      try { const { proof } = z.object({ proof: z.unknown() }).strict().parse(value);
        await authority!.acceptPresence(connection, proof); ack({ ok: true });
      } catch { console.warn('remote_presence_rejected'); ack({ ok: false, code: 'INVALID_NATIVE_EVIDENCE' }); socket.disconnect(true); }
      finally { pending--; }
    });
    for (const event of ['request', 'consent', 'signal', 'ready', 'native-fact', 'control-request', 'pause', 'cancel', 'end']) {
      socket.on(`remote:${event}`, async (raw: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        if (Date.now() - windowAt > 1000) { windowAt = Date.now(); commands = 0; }
        if (pending >= 32 || ++commands > 150) { ack({ ok: false, code: 'REMOTE_BACKPRESSURE' }); return; }
        pending++;
        try {
          // Refuse large payloads before schema/crypto/database work. No SDP/candidates are logged.
          if (Buffer.byteLength(JSON.stringify(raw) || '') > 70000) fail('REMOTE_PAYLOAD_LIMIT');
          const envelope = envelopeSchema.parse(raw);
          if (envelope.connectionGeneration !== 1) fail('CONNECTION_GENERATION_MISMATCH');
          const result = await serial(envelope.sessionId || socket.id, async () => {
            const actor = await authority!.resolveConnection(connection.handle);
            if (event === 'request') {
              if (connection.role !== 'controller' || envelope.sessionId || sessionsBySocket.has(socket.id) || sessions.size >= 128) fail('REMOTE_SESSION_BUSY');
              const input = z.object({ targetDeviceId: uuid, scope: z.enum(['view', 'control']) }).strict().parse(envelope.payload);
              const host = authority!.host(input.targetDeviceId);
              if (!host || !host.presence?.canCapture || (input.scope === 'control' && !host.presence.canControl)) fail('HOST_UNAVAILABLE');
              await authority!.assertCurrent(host!.endpoint);
              const grant = await AssistanceGrant.findOne({ where: { hostDeviceId: input.targetDeviceId, controllerUserId: actor.userId,
                ...activeAssistanceWhere() }, order: [['createdAt', 'DESC']] });
              if (!grant) fail('ASSISTANCE_GRANT_REQUIRED');
              const { session } = await service.request({ requestId: envelope.requestId, grantId: grant!.id, grantCreatedBySid: grant!.createdBySid,
                controller: actor, host: host!.endpoint, scope: input.scope });
              try {
                const proof = await coordinator!.prepareApproval(session.id, connection.handle);
                namespace.to(session.host.connectionId).emit('remote:approval', { ...snapshot(session), proof });
              } catch (error) { await service.end(session.id, 'APPROVAL_UNAVAILABLE'); throw error; }
              return session;
            }
            if (!envelope.sessionId) fail('SESSION_REQUIRED');
            let session = await store.get(envelope.sessionId!);
            if (!session || (!isEndpoint(session.host, actor) && !isEndpoint(session.controller, actor))) fail('NOT_A_PARTICIPANT');
            const current = session!;
            if (['end', 'cancel'].includes(event)) {
              const reason = (envelope.payload as { reason?: unknown }).reason;
              // Diagnostics only: never treat a caller's reason as authorization
              // or persist arbitrary payloads, credentials or SDP in logs.
              console.info('remote_session_end', JSON.stringify({ sessionId: current.id, role: connection.role,
                reason: typeof reason === 'string' && /^REMOTE_[A-Z_]{1,64}$/.test(reason) ? reason : 'UNSPECIFIED' }));
              return coordinator!.end(current.id, connection.handle);
            }
            if (current.state === 'ended') fail('SESSION_ENDED');
            await history.assertAuthorized(current); await authority!.assertReleased(current);
            if (['consent', 'pause', 'control-request'].includes(event) && envelope.expectedRevision !== current.revision) fail('REVISION_CONFLICT');
            if (event === 'consent') {
              const { proof } = z.object({ proof: z.unknown() }).strict().parse(envelope.payload);
              session = await coordinator!.consent(current.id, connection.handle, proof);
              if (session.state === 'ended') return session;
              // Claims have just been authenticated by the coordinator; do not read unverified client fields.
              const verified = JSON.parse(Buffer.from((proof as { payload: string }).payload, 'base64url').toString('utf8'));
              if (verified.decision === 'reject') return session;
              if (session.state === 'connecting') {
                const negotiationId = authority!.beginNegotiation(session);
                const { state: _, ...state } = snapshot(session);
                emit(session, 'remote:connecting', { ...state, host: session.host, controller: session.controller,
                  consentNonce: verified.consentNonce, screenId: verified.screenId, negotiationId, hardDeadline: session.hardDeadline });
              } else {
                const binding = await authority!.negotiation(session);
                emit(session, 'remote:control-approved', { sessionId: session.id, host: session.host, controller: session.controller,
                  consentNonce: verified.consentNonce, screenId: verified.screenId, negotiationId: binding.negotiationId,
                  authorizationRevision: session.authorizationRevision, controlEpoch: session.controlEpoch });
              }
              return session;
            }
            if (event === 'signal') {
              const signal = signalSchema.parse(envelope.payload);
              authority!.signal(current, actor, signal.negotiationId, signal.type, 'sdp' in signal ? signal.sdp : undefined);
              const target = isEndpoint(actor, current.host) ? current.controller : current.host;
              namespace.to(target.connectionId).emit('remote:signal', { ...signal, sessionId: current.id });
              if (signal.type === 'answer') emit(current, 'remote:connection-proof', { sessionId: current.id, proof: await coordinator!.bindTransport(current.id, connection.handle) });
            } else if (event === 'ready') {
              // Browser readiness is diagnostic only. Authority is supplied by native verified DTLS + hello.
              const binding = z.object({ negotiationId: uuid, hostFingerprint: z.string().regex(/^[A-F0-9]{64}$/), controllerFingerprint: z.string().regex(/^[A-F0-9]{64}$/) }).strict().parse(envelope.payload);
              const expected = await authority!.negotiation(current);
              if (connection.role !== 'controller' || Object.keys(binding).some(k => binding[k as keyof typeof binding] !== expected[k as keyof typeof expected])) fail('READY_BINDING_MISMATCH');
            } else if (event === 'native-fact') {
              const { proof } = z.object({ proof: z.unknown() }).strict().parse(envelope.payload);
              const fact = await authority!.nativeFact(current, connection, proof);
              if (fact.type === 'ready') {
                await coordinator!.ready(current.id, connection.handle, fact.handle);
                session = await coordinator!.ready(current.id, authority!.connection(current.controller).handle, fact.controllerHandle);
              } else emit(current, 'remote:lease', { sessionId: current.id, proof: await coordinator!.lease(current.id, connection.handle, fact.handle) });
            } else if (event === 'pause') {
              empty.parse(envelope.payload); session = await coordinator!.pause(current.id, connection.handle);
            } else if (event === 'control-request') {
              empty.parse(envelope.payload);
              if (connection.role !== 'controller') fail('CONTROLLER_REQUIRED');
              const proof = await coordinator!.prepareApproval(current.id, connection.handle);
              namespace.to(current.host.connectionId).emit('remote:approval', { ...snapshot(current), proof });
            }
            return session!;
          });
          ack({ ok: true, sessionId: result.id, revision: result.revision, state: result.state });
        } catch (error) {
          const code = error instanceof RemoteControlError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'REMOTE_SERVICE_UNAVAILABLE';
          console.warn('remote_command_rejected', JSON.stringify({ event, role: connection.role, code }));
          ack({ ok: false, code });
          if (['AUTH_REVOKED', 'REMOTE_DISCONNECTED', 'REMOTE_SERVICE_UNAVAILABLE'].includes(code)) socket.disconnect(true);
        } finally { pending--; }
      });
    }
  });
  return namespace;
}
