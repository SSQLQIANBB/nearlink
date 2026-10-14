import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../../../src/config/env';
import {
  generateTokenPair,
  verifyAccessToken,
  verifyAccessTokenForLogout,
  verifyRefreshToken,
} from '../../../src/utils/jwt';

const payload = {
  userId: 7,
  username: 'alice',
  sid: '270b6b58-c4d3-444d-a8bc-21c9e0d8ba40',
  authVersion: 'v1',
};
describe('JWT purpose and rotation', () => {
  it('keeps login session identity but generates unique token IDs within one second', () => {
    const first = generateTokenPair(payload);
    const second = generateTokenPair(payload);
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(verifyAccessToken(second.accessToken)).toMatchObject({ ...payload, type: 'access' });
    expect(verifyRefreshToken(second.refreshToken)).toMatchObject({ ...payload, type: 'refresh' });
  });
  it('rejects a refresh-purpose JWT even when signed with the access key', () => {
    const token = jwt.sign({ ...payload, type: 'refresh' }, env.auth.jwtSecret, { expiresIn: 60 });
    expect(() => verifyAccessToken(token)).toThrow();
  });
  it('rejects missing expiration and nonnumeric user identities', () => {
    expect(() =>
      verifyAccessToken(jwt.sign({ ...payload, type: 'access' }, env.auth.jwtSecret)),
    ).toThrow();
    expect(() =>
      verifyAccessToken(
        jwt.sign({ ...payload, userId: '7', type: 'access' }, env.auth.jwtSecret, {
          expiresIn: 60,
        }),
      ),
    ).toThrow();
  });
  it('accepts a genuinely expired access JWT only through the logout verifier', () => {
    const token = jwt.sign({ ...payload, type: 'access' }, env.auth.jwtSecret, { expiresIn: -1 });
    expect(() => verifyAccessToken(token)).toThrow();
    expect(() => verifyRefreshToken(token)).toThrow();
    expect(verifyAccessTokenForLogout(token)).toMatchObject({ ...payload, type: 'access' });
  });
  it('logout exception retains signature, algorithm, purpose and expiration-claim validation', () => {
    const candidates = [
      jwt.sign({ ...payload, type: 'access' }, 'forged-secret', { expiresIn: -1 }),
      jwt.sign({ ...payload, type: 'refresh' }, env.auth.jwtSecret, { expiresIn: -1 }),
      jwt.sign({ ...payload, type: 'access' }, env.auth.jwtSecret, {
        expiresIn: -1,
        algorithm: 'HS384',
      }),
      jwt.sign({ ...payload, type: 'access' }, env.auth.jwtSecret),
      generateTokenPair(payload).refreshToken,
    ];
    for (const token of candidates) expect(() => verifyAccessTokenForLogout(token)).toThrow();
  });
});
