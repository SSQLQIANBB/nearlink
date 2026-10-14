import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sequelize } from 'sequelize';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../src/config/env';
import { authMiddleware, logoutAuthMiddleware } from '../../src/middleware/auth';

const testUrl = process.env.AUTH_TEST_MYSQL_URL;
if (testUrl && !/^todesk_auth_test_[a-zA-Z0-9_]+$/.test(new URL(testUrl).pathname.slice(1))) {
  throw new Error('AUTH_TEST_MYSQL_URL must name a disposable todesk_auth_test_* database');
}
vi.mock('../../src/config/database', async () => {
  const { Sequelize } = await import('sequelize');
  return {
    default: new Sequelize(
      process.env.AUTH_TEST_MYSQL_URL || 'mysql://root@127.0.0.1/todesk_auth_test_disabled',
      {
        dialect: 'mysql',
        logging: false,
        pool: { max: 8, min: 0 },
      },
    ),
  };
});
import sequelize from '../../src/config/database';
import User from '../../src/models/User';
import LoginSession from '../../src/models/LoginSession';
import {
  createLoginSession,
  rotateLoginSession,
  validateAuthenticatedSession,
  validateLogoutSession,
  revokeLoginSession,
  replacePasswordAndRevokeSessions,
  onLoginSessionsRevoked,
} from '../../src/services/loginSessionService';
import { getTokenVersion, isTokenVersionCurrent } from '../../src/services/tokenVersionService';
import { generateAccessToken, verifyRefreshToken } from '../../src/utils/jwt';

const suite = testUrl ? describe : describe.skip;
suite('durable login sessions (real MySQL transactions)', () => {
  let user: User;
  beforeAll(async () => {
    await sequelize.authenticate();
    await User.sync({ force: true });
    await LoginSession.sync({ force: true });
  });
  beforeEach(async () => {
    await LoginSession.destroy({ where: {} });
    await User.destroy({ where: {} });
    user = await User.create({ username: 'alice', password: 'old-hash' });
  });
  afterAll(async () => {
    await LoginSession.drop();
    await User.drop();
    await sequelize.close();
  });

  it('two devices independently rotate; logout leaves the other login usable', async () => {
    const first = await createLoginSession(user.id);
    const second = await createLoginSession(user.id);
    expect(first.loginSessionId).not.toBe(second.loginSessionId);
    const rotated = await Promise.all([
      rotateLoginSession(first.refreshToken, randomUUID()),
      rotateLoginSession(second.refreshToken, randomUUID()),
    ]);
    await revokeLoginSession(user.id, first.loginSessionId);
    await expect(validateAuthenticatedSession(rotated[0].accessToken)).rejects.toThrow();
    await expect(rotateLoginSession(rotated[0].refreshToken, randomUUID())).rejects.toThrow();
    await expect(validateAuthenticatedSession(rotated[1].accessToken)).resolves.toMatchObject({
      sid: second.loginSessionId,
    });
    await expect(rotateLoginSession(rotated[1].refreshToken, randomUUID())).resolves.toHaveProperty(
      'accessToken',
    );
  });

  it('expired access can revoke only its own sid through logout, never ordinary authentication', async () => {
    const first = await createLoginSession(user.id);
    const second = await createLoginSession(user.id);
    const claims = {
      userId: user.id,
      username: user.username,
      sid: first.loginSessionId,
      authVersion: user.authVersion,
      type: 'access',
    };
    const expired = jwt.sign(claims, env.auth.jwtSecret, { expiresIn: -1 });
    await expect(validateAuthenticatedSession(expired)).rejects.toThrow();
    const ordinary = { headers: { authorization: `Bearer ${expired}` }, state: {} } as any;
    const protectedOperation = vi.fn();
    await authMiddleware(ordinary, protectedOperation);
    expect(ordinary.status).toBe(401);
    expect(protectedOperation).not.toHaveBeenCalled();
    const logout = {
      headers: { authorization: `Bearer ${expired}` },
      state: {},
      request: { body: { sid: second.loginSessionId, userId: user.id + 1 } },
    } as any;
    await logoutAuthMiddleware(logout, async () => {
      await revokeLoginSession(logout.state.user.userId, logout.state.user.sid);
    });
    await expect(rotateLoginSession(first.refreshToken, randomUUID())).rejects.toThrow();
    await expect(validateLogoutSession(expired)).rejects.toThrow();
    await expect(validateAuthenticatedSession(second.accessToken)).resolves.toMatchObject({
      sid: second.loginSessionId,
    });
    await expect(rotateLoginSession(second.refreshToken, randomUUID())).resolves.toHaveProperty(
      'accessToken',
    );
  });

  it('logout rejects forged signatures, refresh purpose and mismatched durable account/session claims', async () => {
    const session = await createLoginSession(user.id);
    const other = await User.create({ username: 'bob', password: 'other-hash' });
    const claims = {
      userId: user.id,
      username: user.username,
      sid: session.loginSessionId,
      authVersion: user.authVersion,
      type: 'access',
    };
    const invalid = [
      jwt.sign(claims, 'wrong-key', { expiresIn: -1 }),
      session.refreshToken,
      jwt.sign({ ...claims, type: 'refresh' }, env.auth.jwtSecret, { expiresIn: -1 }),
      jwt.sign(
        { ...claims, userId: other.id, authVersion: other.authVersion },
        env.auth.jwtSecret,
        { expiresIn: -1 },
      ),
      jwt.sign({ ...claims, authVersion: randomUUID() }, env.auth.jwtSecret, { expiresIn: -1 }),
    ];
    for (const token of invalid) {
      const ctx = { headers: { authorization: `Bearer ${token}` }, state: {} } as any;
      const revoke = vi.fn();
      await logoutAuthMiddleware(ctx, revoke);
      expect(ctx.status).toBe(401);
      expect(revoke).not.toHaveBeenCalled();
    }
    await expect(validateAuthenticatedSession(session.accessToken)).resolves.toHaveProperty('sid');
  });

  it('concurrent rotation CAS has one winner and retry recovers only the matching request', async () => {
    const session = await createLoginSession(user.id);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const attempts = await Promise.allSettled([
      rotateLoginSession(session.refreshToken, firstId),
      rotateLoginSession(session.refreshToken, secondId),
    ]);
    expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const index = attempts.findIndex((value) => value.status === 'fulfilled');
    const result = attempts[index] as PromiseFulfilledResult<{
      accessToken: string;
      refreshToken: string;
    }>;
    expect(
      await rotateLoginSession(session.refreshToken, index === 0 ? firstId : secondId),
    ).toEqual(result.value);
    const row = await LoginSession.findByPk(session.loginSessionId);
    expect(row!.version).toBe(1);
    expect(row!.rotationResponse).not.toContain(result.value.refreshToken);
    expect(row!.refreshHash).not.toBe(result.value.refreshToken);
    // The cached response cannot be returned for a different presented token.
    await expect(
      rotateLoginSession(result.value.refreshToken, index === 0 ? firstId : secondId),
    ).rejects.toThrow();
  });

  it('cached rotation expires and cannot recover tokens after logout', async () => {
    const session = await createLoginSession(user.id);
    const id = randomUUID();
    await rotateLoginSession(session.refreshToken, id);
    await LoginSession.update(
      { rotationExpiresAt: new Date(Date.now() - 1_000) },
      { where: { id: session.loginSessionId } },
    );
    await expect(rotateLoginSession(session.refreshToken, id)).rejects.toThrow();
    await revokeLoginSession(user.id, session.loginSessionId);
    await expect(rotateLoginSession(session.refreshToken, id)).rejects.toThrow();
    expect((await LoginSession.findByPk(session.loginSessionId))!.rotationResponse).toBeNull();
  });

  it('refresh racing logout never leaves usable credentials', async () => {
    for (let i = 0; i < 5; i++) {
      const session = await createLoginSession(user.id);
      const requestId = randomUUID();
      const results = await Promise.allSettled([
        rotateLoginSession(session.refreshToken, requestId),
        revokeLoginSession(user.id, session.loginSessionId),
      ]);
      expect(results[1].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled')
        await expect(validateAuthenticatedSession(results[0].value!.accessToken)).rejects.toThrow();
      await expect(rotateLoginSession(session.refreshToken, requestId)).rejects.toThrow();
      expect((await LoginSession.findByPk(session.loginSessionId))!.revokedAt).not.toBeNull();
    }
  });

  it('password change racing refresh atomically changes version and revokes all devices', async () => {
    const first = await createLoginSession(user.id);
    const second = await createLoginSession(user.id);
    const oldVersion = await getTokenVersion(user.id);
    const id = randomUUID();
    const results = await Promise.allSettled([
      rotateLoginSession(first.refreshToken, id),
      replacePasswordAndRevokeSessions(user.id, 'new-hash', {
        password: 'old-hash',
        authVersion: oldVersion,
      }),
    ]);
    expect(results[1].status).toBe('fulfilled');
    expect(await getTokenVersion(user.id)).not.toBe(oldVersion);
    expect((await User.findByPk(user.id))!.password).toBe('new-hash');
    await expect(validateAuthenticatedSession(second.accessToken)).rejects.toThrow();
    await expect(rotateLoginSession(first.refreshToken, id)).rejects.toThrow();
    if (results[0].status === 'fulfilled')
      await expect(validateAuthenticatedSession(results[0].value!.accessToken)).rejects.toThrow();
    // A password validated before the reset cannot mint a login after it.
    await expect(
      createLoginSession(user.id, { password: 'old-hash', authVersion: oldVersion }),
    ).rejects.toThrow();
  });

  it('rolls back password and version if revoking the session rows fails', async () => {
    const session = await createLoginSession(user.id);
    const prior = await getTokenVersion(user.id);
    await sequelize.query(
      "CREATE TRIGGER fail_session_revoke BEFORE UPDATE ON login_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test fault'",
    );
    try {
      await expect(replacePasswordAndRevokeSessions(user.id, 'new-hash')).rejects.toThrow(
        'test fault',
      );
      expect((await User.findByPk(user.id))!.password).toBe('old-hash');
      expect(await getTokenVersion(user.id)).toBe(prior);
      await expect(validateAuthenticatedSession(session.accessToken)).resolves.toHaveProperty(
        'sid',
      );
    } finally {
      await sequelize.query('DROP TRIGGER fail_session_revoke');
    }
  });

  it('version remains persistent across service reconnect, and legacy/null versions never validate', async () => {
    const session = await createLoginSession(user.id);
    const version = await getTokenVersion(user.id);
    const separate = new Sequelize(testUrl!, { logging: false });
    try {
      const [rows] = await separate.query('SELECT authVersion FROM users WHERE id = ?', {
        replacements: [user.id],
      });
      expect((rows as { authVersion: string }[])[0].authVersion).toBe(version);
    } finally {
      await separate.close();
    }
    expect(await isTokenVersionCurrent(user.id, null)).toBe(false);
    expect(await isTokenVersionCurrent(user.id, version)).toBe(true);
    await expect(
      validateAuthenticatedSession(
        generateAccessToken({ userId: user.id, username: user.username, authVersion: version }),
      ),
    ).rejects.toThrow();
    await expect(validateAuthenticatedSession(session.refreshToken)).rejects.toThrow();
    expect(verifyRefreshToken(session.refreshToken).authVersion).toBe(version);
  });

  it('publishes revocation only after commit and observer failure cannot undo revocation', async () => {
    const session = await createLoginSession(user.id);
    let received = false;
    const unsubscribe = onLoginSessionsRevoked(async (event) => {
      expect(event).toEqual({ userId: user.id, sid: session.loginSessionId });
      expect((await LoginSession.findByPk(event.sid!))!.revokedAt).not.toBeNull();
      received = true;
      throw new Error('notification unavailable');
    });
    try {
      await revokeLoginSession(user.id, session.loginSessionId);
      expect(received).toBe(true);
      await expect(validateAuthenticatedSession(session.accessToken)).rejects.toThrow();
    } finally {
      unsubscribe();
    }
  });
});
