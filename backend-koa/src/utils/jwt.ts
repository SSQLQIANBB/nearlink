import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';

export const ACCESS_TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export interface JwtPayload {
  userId: number;
  username: string;
  sid?: string;
  authVersion?: string | null;
  type?: 'access' | 'refresh';
  exp?: number;
  iat?: number;
  jti?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function sign(payload: JwtPayload, type: 'access' | 'refresh'): string {
  // Never carry an old token's timestamps or ID into a rotation.
  const { userId, username, sid, authVersion } = payload;
  return jwt.sign(
    { userId, username, sid, authVersion, type },
    type === 'access' ? env.auth.jwtSecret : env.auth.refreshTokenSecret,
    {
      algorithm: 'HS256',
      expiresIn: type === 'access' ? ACCESS_TOKEN_LIFETIME_SECONDS : REFRESH_TOKEN_LIFETIME_SECONDS,
      jwtid: randomUUID(),
    },
  );
}

export const generateAccessToken = (payload: JwtPayload) => sign(payload, 'access');
export const generateRefreshToken = (payload: JwtPayload) => sign(payload, 'refresh');
export function generateTokenPair(payload: JwtPayload): TokenPair {
  return { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) };
}

function verify(token: string, type: 'access' | 'refresh', ignoreExpiration = false): JwtPayload {
  try {
    const value = jwt.verify(
      token,
      type === 'access' ? env.auth.jwtSecret : env.auth.refreshTokenSecret,
      { algorithms: ['HS256'], ignoreExpiration },
    );
    if (
      typeof value === 'string' ||
      value.type !== type ||
      !Number.isSafeInteger(value.userId) ||
      value.userId <= 0 ||
      typeof value.username !== 'string' ||
      !value.username ||
      !Number.isSafeInteger(value.exp)
    )
      throw new Error();
    return value as JwtPayload;
  } catch {
    throw new Error(`无效的${type} token`);
  }
}

export const verifyAccessToken = (token: string) => verify(token, 'access');
/** Only the logout-only revocation path may accept an expired, otherwise valid access JWT. */
export const verifyAccessTokenForLogout = (token: string) => verify(token, 'access', true);
export const verifyRefreshToken = (token: string) => verify(token, 'refresh');
export const generateToken = generateAccessToken;
export const verifyToken = verifyAccessToken;
