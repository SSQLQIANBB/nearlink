import { Context, Next } from 'koa';
import {
  AuthenticatedSessionPayload,
  validateAuthenticatedSession,
  validateLogoutSession,
} from '../services/loginSessionService';

export interface AuthState {
  user?: AuthenticatedSessionPayload;
}
const bearer = (ctx: Context) => /^Bearer ([^\s]+)$/i.exec(ctx.headers.authorization || '')?.[1];

export async function authMiddleware(ctx: Context, next: Next) {
  const token = bearer(ctx);
  if (!token) {
    ctx.status = 401;
    ctx.body = { error: '未提供认证token' };
    return;
  }
  try {
    ctx.state.user = await validateAuthenticatedSession(token);
  } catch {
    ctx.status = 401;
    ctx.body = { error: '登录会话已失效，请重新登录' };
    return;
  }
  // Application failures must not be rewritten as authentication failures.
  await next();
}

/** Use exclusively on POST /logout; it grants no read/write access beyond revocation. */
export async function logoutAuthMiddleware(ctx: Context, next: Next) {
  const token = bearer(ctx);
  if (!token) {
    ctx.status = 401;
    ctx.body = { error: '未提供认证token' };
    return;
  }
  try {
    ctx.state.user = await validateLogoutSession(token);
  } catch {
    ctx.status = 401;
    ctx.body = { error: '登录会话已失效' };
    return;
  }
  await next();
}

export async function optionalAuthMiddleware(ctx: Context, next: Next) {
  const token = bearer(ctx);
  delete ctx.state.user;
  if (token) {
    try {
      ctx.state.user = await validateAuthenticatedSession(token);
    } catch {
      /* anonymous */
    }
  }
  await next();
}
