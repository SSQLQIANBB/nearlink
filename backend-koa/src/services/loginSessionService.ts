import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { Op, QueryTypes, Transaction } from 'sequelize';
import User from '../models/User';
import LoginSession from '../models/LoginSession';
import { env } from '../config/env';
import {
  generateTokenPair,
  JwtPayload,
  TokenPair,
  verifyAccessToken,
  verifyAccessTokenForLogout,
  verifyRefreshToken,
  REFRESH_TOKEN_LIFETIME_SECONDS,
} from '../utils/jwt';

export interface AuthenticatedSessionPayload extends JwtPayload {
  sid: string;
  authVersion: string;
  exp: number;
}
export interface SessionRevocation {
  userId: number;
  sid?: string;
  revokedAuthVersion?: string;
  currentAuthVersion?: string;
}
type RevocationListener = (event: SessionRevocation) => void | Promise<void>;
const listeners = new Set<RevocationListener>();
export function onLoginSessionsRevoked(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
async function notifyRevocation(event: SessionRevocation) {
  // Persistence is authoritative; notification failures cannot roll revocation back.
  await Promise.allSettled(
    [...listeners].map((listener) => Promise.resolve().then(() => listener(event))),
  );
}

export class InvalidLoginSessionError extends Error {
  constructor() {
    super('登录会话已失效，请重新登录');
  }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const responseKey = () =>
  createHash('sha256')
    .update('login-session-rotation-v1\0')
    .update(env.auth.refreshTokenSecret)
    .digest();
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const expiry = () => new Date(Date.now() + REFRESH_TOKEN_LIFETIME_SECONDS * 1000);
const emptyRotation = {
  rotationRequestId: null,
  rotationInputHash: null,
  rotationResponse: null,
  rotationExpiresAt: null,
};

function encryptResponse(tokens: TokenPair, sid: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', responseKey(), iv);
  cipher.setAAD(Buffer.from(sid));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decryptResponse(value: string, sid: string): TokenPair {
  const packed = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', responseKey(), packed.subarray(0, 12));
  cipher.setAAD(Buffer.from(sid));
  cipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8'),
  );
}
function requireSessionClaims(payload: JwtPayload): AuthenticatedSessionPayload {
  if (
    typeof payload.sid !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(payload.sid) ||
    typeof payload.authVersion !== 'string' ||
    !payload.authVersion ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new InvalidLoginSessionError();
  }
  return payload as AuthenticatedSessionPayload;
}
function assertCurrent(
  user: User | null,
  session: LoginSession | null,
  payload: AuthenticatedSessionPayload,
) {
  if (
    !user ||
    !user.authVersion ||
    user.authVersion !== payload.authVersion ||
    !session ||
    session.userId !== payload.userId ||
    session.authVersion !== payload.authVersion ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now()
  )
    throw new InvalidLoginSessionError();
}

async function validateSessionState(claims: JwtPayload): Promise<AuthenticatedSessionPayload> {
  const payload = requireSessionClaims(claims);
  // One statement reads the account and session at a single database snapshot.
  const rows = await User.sequelize!.query<{ id: string }>(
    `SELECT s.id FROM login_sessions s JOIN users u ON u.id = s.userId
     WHERE s.id = :sid AND s.userId = :userId AND s.authVersion = :authVersion
       AND u.authVersion = :authVersion AND s.revokedAt IS NULL AND s.expiresAt > :now`,
    {
      replacements: {
        sid: payload.sid,
        userId: payload.userId,
        authVersion: payload.authVersion,
        now: new Date(),
      },
      type: QueryTypes.SELECT,
    },
  );
  if (rows.length !== 1) throw new InvalidLoginSessionError();
  return payload;
}

/** Protected REST, Socket and remote-control operations always enforce access expiry. */
export async function validateAuthenticatedSession(
  token: string,
): Promise<AuthenticatedSessionPayload> {
  return validateSessionState(verifyAccessToken(token));
}

/** Logout-only: expiration may not prevent revoking an otherwise active durable sid. */
export async function validateLogoutSession(token: string): Promise<AuthenticatedSessionPayload> {
  return validateSessionState(verifyAccessTokenForLogout(token));
}

/** Lock order is always user -> session for login, refresh, logout and account revocation. */
export async function createLoginSession(
  userId: number,
  expected?: { authVersion?: string; password?: string },
): Promise<TokenPair & { loginSessionId: string }> {
  return User.sequelize!.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (
      !user?.authVersion ||
      (expected?.authVersion !== undefined && expected.authVersion !== user.authVersion) ||
      (expected?.password !== undefined && expected.password !== user.password)
    )
      throw new InvalidLoginSessionError();
    const sid = randomUUID();
    const tokens = generateTokenPair({
      userId,
      username: user.username,
      sid,
      authVersion: user.authVersion,
    });
    await LoginSession.create(
      {
        id: sid,
        userId,
        authVersion: user.authVersion,
        refreshHash: tokenHash(tokens.refreshToken),
        version: 0,
        expiresAt: expiry(),
      },
      { transaction },
    );
    return { ...tokens, loginSessionId: sid };
  });
}

export async function rotateLoginSession(
  refreshToken: string,
  requestId: string = randomUUID(),
): Promise<TokenPair> {
  const payload = requireSessionClaims(verifyRefreshToken(refreshToken));
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId))
    throw new InvalidLoginSessionError();
  const inputHash = tokenHash(refreshToken);
  return User.sequelize!.transaction(async (transaction) => {
    const user = await User.findByPk(payload.userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const session = await LoginSession.findByPk(payload.sid, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    assertCurrent(user, session, payload);
    // A cached response is usable only after checking current durable revocation state.
    if (session!.rotationRequestId === requestId) {
      if (
        session!.rotationInputHash &&
        sameHash(session!.rotationInputHash, inputHash) &&
        session!.rotationExpiresAt &&
        session!.rotationExpiresAt.getTime() > Date.now() &&
        session!.rotationResponse
      ) {
        return decryptResponse(session!.rotationResponse, payload.sid);
      }
      throw new InvalidLoginSessionError();
    }
    if (!sameHash(session!.refreshHash, inputHash)) throw new InvalidLoginSessionError();
    const tokens = generateTokenPair({
      userId: user!.id,
      username: user!.username,
      sid: payload.sid,
      authVersion: user!.authVersion,
    });
    // CAS supplements the row lock and prevents accidental future unlocked writers from reviving credentials.
    const [changed] = await LoginSession.update(
      {
        refreshHash: tokenHash(tokens.refreshToken),
        version: session!.version + 1,
        expiresAt: expiry(),
        rotationRequestId: requestId,
        rotationInputHash: inputHash,
        rotationResponse: encryptResponse(tokens, payload.sid),
        rotationExpiresAt: new Date(Date.now() + 10_000),
      },
      {
        where: {
          id: payload.sid,
          userId: payload.userId,
          version: session!.version,
          revokedAt: null,
          authVersion: payload.authVersion,
          refreshHash: inputHash,
        },
        transaction,
      },
    );
    if (changed !== 1) throw new InvalidLoginSessionError();
    return tokens;
  });
}

export async function revokeLoginSession(userId: number, sid: string): Promise<void> {
  await User.sequelize!.transaction(async (transaction) => {
    await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    await LoginSession.update(
      { revokedAt: new Date(), ...emptyRotation },
      { where: { id: sid, userId, revokedAt: null }, transaction },
    );
  });
  await notifyRevocation({ userId, sid });
}

async function revokeAllLocked(user: User, transaction: Transaction, password?: string) {
  await user.update(
    { authVersion: randomUUID(), ...(password === undefined ? {} : { password }) },
    { transaction },
  );
  await LoginSession.update(
    { revokedAt: new Date(), ...emptyRotation },
    { where: { userId: user.id, revokedAt: null }, transaction },
  );
}
export async function revokeAllLoginSessions(userId: number): Promise<void> {
  const versions = await User.sequelize!.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw new InvalidLoginSessionError();
    const revokedAuthVersion = user.authVersion;
    await revokeAllLocked(user, transaction);
    return { revokedAuthVersion, currentAuthVersion: user.authVersion };
  });
  await notifyRevocation({ userId, ...versions });
}

/** Password and account revocation commit together; stale password verification cannot win a race. */
export async function replacePasswordAndRevokeSessions(
  userId: number,
  password: string,
  expected?: { password?: string; authVersion?: string },
) {
  const versions = await User.sequelize!.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (
      !user ||
      (expected?.password !== undefined && expected.password !== user.password) ||
      (expected?.authVersion !== undefined && expected.authVersion !== user.authVersion)
    )
      throw new InvalidLoginSessionError();
    const revokedAuthVersion = user.authVersion;
    await revokeAllLocked(user, transaction, password);
    return { revokedAuthVersion, currentAuthVersion: user.authVersion };
  });
  await notifyRevocation({ userId, ...versions });
}

export async function hasActiveLoginSessions(userId: number): Promise<boolean> {
  return (
    (await LoginSession.count({
      where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    })) > 0
  );
}
