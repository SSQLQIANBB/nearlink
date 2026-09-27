import { assistanceExpired } from './assistanceGrantPolicy';
import { Op, QueryTypes, Transaction } from 'sequelize';
import { RemoteSessionRecord, RemoteSessionEvent, RemoteDevice, AssistanceGrant } from '../models/RemoteControl';
import User from '../models/User';
import LoginSession from '../models/LoginSession';
import { RemoteControlError, type RemoteSession } from './remoteControlProtocol';
import type { SessionRevocation } from './loginSessionService';

export interface PreparedRemoteRequest { created: boolean; sessionId: string; state: string }
export interface RemoteHistoryWriter {
  prepareRequest(session: RemoteSession): Promise<PreparedRemoteRequest>;
  assertAuthorized(session: RemoteSession, admission?: boolean): Promise<void>;
  archiveEnd(session: RemoteSession): Promise<void>;
}

/** Durable admission and audit only. Historical rows never recreate a live Redis session. */
export class RemoteSessionHistory implements RemoteHistoryWriter {
  async assertAuthorized(session: RemoteSession, admission = false, transaction?: Transaction): Promise<void> {
    if (!session.grantCreatedBySid) throw new RemoteControlError('GRANT_CREATOR_REQUIRED', 403);
    const users = await User.findAll({ where: { id: { [Op.in]: [...new Set([session.controller.userId, session.host.userId])] } },
      order: [['id', 'ASC']], attributes: ['id', 'authVersion'], transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const byUser = new Map(users.map(user => [user.id, user.authVersion]));
    const sessions = await LoginSession.findAll({ where: { id: { [Op.in]: [...new Set([session.controller.sid, session.host.sid, session.grantCreatedBySid])] } }, transaction });
    const bySid = new Map(sessions.map(row => [row.id, row]));
    for (const identity of [session.controller, session.host, { ...session.host, sid: session.grantCreatedBySid }]) {
      const row = bySid.get(identity.sid);
      if (!row || row.userId !== identity.userId || row.authVersion !== identity.authVersion
        || byUser.get(identity.userId) !== identity.authVersion || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
        throw new RemoteControlError('AUTH_REVOKED', 401);
      }
    }
    const [device, grant] = await Promise.all([
      RemoteDevice.findByPk(session.host.endpointId, { transaction }), AssistanceGrant.findByPk(session.grantId, { transaction }),
    ]);
    if (!device || device.revokedAt || device.ownerUserId !== session.host.userId || !grant || grant.revokedAt
      || grant.hostDeviceId !== device.id || grant.createdBySid !== session.grantCreatedBySid
      || grant.controllerUserId !== session.controller.userId || (admission && assistanceExpired(grant.expiresAt))) {
      throw new RemoteControlError('TARGET_UNAVAILABLE', 403);
    }
  }

  async prepareRequest(session: RemoteSession): Promise<PreparedRemoteRequest> {
    return RemoteSessionRecord.sequelize!.transaction(async transaction => {
      await this.assertAuthorized(session, true, transaction);
      // The controller account lock serializes this durable idempotency key with revocation.
      const prior = await RemoteSessionRecord.findOne({ where: { controllerSid: session.controller.sid, requestId: session.requestId }, transaction });
      if (prior) {
        if (prior.requestHash !== session.requestHash) throw new RemoteControlError('IDEMPOTENCY_CONFLICT');
        return { created: false, sessionId: prior.sessionId, state: prior.state };
      }
      await RemoteSessionRecord.create({
        sessionId: session.id, requestId: session.requestId, requestHash: session.requestHash,
        controllerUserId: session.controller.userId, hostUserId: session.host.userId,
        controllerSid: session.controller.sid, hostSid: session.host.sid, controllerEndpointId: session.controller.endpointId,
        hostDeviceId: session.host.endpointId, grantId: session.grantId, grantCreatedBySid: session.grantCreatedBySid,
        scope: session.requestedScope, state: 'pending', revision: 0, createdAt: new Date(session.createdAt),
      }, { transaction });
      await RemoteSessionEvent.create({ sessionId: session.id, eventSeq: 0, eventType: 'requested',
        occurredAt: new Date(session.createdAt), observedAt: new Date() }, { transaction });
      return { created: true, sessionId: session.id, state: 'pending' };
    });
  }

  async archiveEnd(session: RemoteSession): Promise<void> {
    if (session.state !== 'ended' || !Number.isFinite(session.endedAt) || !Number.isSafeInteger(session.revision)
      || session.revision < 1) throw new RemoteControlError('INVALID_TERMINAL_EVENT');
    await RemoteSessionRecord.sequelize!.transaction(async transaction => {
      const record = await RemoteSessionRecord.findByPk(session.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!record || record.controllerSid !== session.controller.sid || record.hostSid !== session.host.sid
        || record.controllerUserId !== session.controller.userId || record.hostUserId !== session.host.userId
        || record.hostDeviceId !== session.host.endpointId || record.grantId !== session.grantId
        || record.requestHash !== session.requestHash) throw new RemoteControlError('HISTORY_IDENTITY_MISMATCH');
      if (record.state === 'ended' && record.revision >= session.revision) return;
      const reason = (session.reason || 'ENDED').slice(0, 64);
      await RemoteSessionEvent.findOrCreate({ where: { sessionId: session.id, eventSeq: session.revision },
        defaults: { sessionId: session.id, eventSeq: session.revision, eventType: 'ended', reason,
          occurredAt: new Date(session.endedAt!), observedAt: new Date() }, transaction });
      await record.update({ state: 'ended', scope: session.scope, revision: session.revision,
        endedAt: new Date(session.endedAt!), endReason: reason }, { transaction });
    });
  }

  async incomplete(afterId: string | null, before: Date, limit: number) {
    return RemoteSessionRecord.findAll({ where: { state: { [Op.in]: ['pending', 'connecting', 'active'] },
      createdAt: { [Op.lt]: before }, ...(afterId ? { sessionId: { [Op.gt]: afterId } } : {}) },
      order: [['sessionId', 'ASC']], limit });
  }

  async markInterrupted(id: string): Promise<void> {
    await RemoteSessionRecord.sequelize!.transaction(async transaction => {
      const row = await RemoteSessionRecord.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row || ['ended', 'interrupted'].includes(row.state)) return;
      await RemoteSessionEvent.findOrCreate({ where: { sessionId: id, eventSeq: -1 },
        defaults: { sessionId: id, eventSeq: -1, eventType: 'interrupted', reason: 'RUNTIME_STATE_LOST',
          occurredAt: null, observedAt: new Date() }, transaction });
      // observedAt is evidence of detection, not evidence of the actual end time.
      await row.update({ state: 'interrupted', endedAt: null, endReason: 'RUNTIME_STATE_LOST' }, { transaction });
    });
  }

  async pruneTerminal(before: Date, afterId: string | null, limit: number, canDelete: (id: string) => Promise<boolean>) {
    return RemoteSessionRecord.sequelize!.transaction(async transaction => {
      const candidates = await RemoteSessionRecord.findAll({ where: {
        state: { [Op.in]: ['ended', 'interrupted'] }, updatedAt: { [Op.lt]: before },
        ...(afterId ? { sessionId: { [Op.gt]: afterId } } : {}),
      }, order: [['sessionId', 'ASC']], limit: Math.max(1, Math.min(100, limit)), transaction, lock: transaction.LOCK.UPDATE });
      let deleted = 0;
      for (const candidate of candidates) {
        // Redis failures roll this whole SQL transaction back. Pending outbox/live state is protected.
        if (!await canDelete(candidate.sessionId)) continue;
        await RemoteSessionEvent.destroy({ where: { sessionId: candidate.sessionId }, transaction });
        await candidate.destroy({ transaction });
        deleted++;
      }
      return { scanned: candidates.length, deleted, afterId: candidates.at(-1)?.sessionId || afterId };
    });
  }

  async revokeGrants(event: SessionRevocation): Promise<void> {
    if (event.sid) {
      await AssistanceGrant.update({ revokedAt: new Date() }, { where: { createdBySid: event.sid, revokedAt: null } });
      return;
    }
    await AssistanceGrant.sequelize!.query(
      `UPDATE remote_assistance_grants SET revokedAt = :now, updatedAt = :now
       WHERE revokedAt IS NULL AND createdBySid IN
         (SELECT id FROM login_sessions WHERE userId = :userId AND revokedAt IS NOT NULL
          ${event.revokedAuthVersion ? 'AND authVersion = :revokedAuthVersion' : ''})`,
      { replacements: { now: new Date(), userId: event.userId, revokedAuthVersion: event.revokedAuthVersion || null }, type: QueryTypes.UPDATE },
    );
  }
}
