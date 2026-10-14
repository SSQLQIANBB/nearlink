import { Context } from 'koa';
import redis from '../config/redis';
import { User, UserEmail } from '../models';
import redisService from '../services/redisService';
import { hashPassword } from '../utils/crypto';
import { isValidNewPassword, PASSWORD_RULE_MESSAGE } from '../utils/passwordPolicy';
import { replacePasswordAndRevokeSessions } from '../services/loginSessionService';
import {
  consumeEmailCode,
  isMailConfigured,
  issueEmailCode,
  normalizeEmail,
  type EmailCodePurpose,
} from '../services/emailVerificationService';

const CODE_SENT_MESSAGE = '验证码已发送';

async function limitRequests(ctx: Context) {
  const key = `email:ip:${ctx.ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  return count <= 20;
}

async function issue(ctx: Context, purpose: EmailCodePurpose) {
  const email = normalizeEmail((ctx.request.body as any)?.email);
  if (!email) {
    ctx.status = 400;
    ctx.body = { error: '请输入有效邮箱' };
    return;
  }
  if (!isMailConfigured()) {
    ctx.status = 503;
    ctx.body = { error: '邮件服务未配置' };
    return;
  }
  if (!(await limitRequests(ctx))) {
    ctx.status = 429;
    ctx.body = { error: '请求过于频繁，请稍后再试' };
    return;
  }

  try {
    const binding = await UserEmail.findOne({ where: { email } });
    const anonymousPurpose = purpose === 'reset' || purpose === 'login';
    if (anonymousPurpose && !binding) {
      ctx.status = 404;
      ctx.body = { error: '该邮箱未注册' };
      return;
    }
    if (purpose === 'register' && binding) {
      ctx.status = 409;
      ctx.body = { error: '该邮箱已绑定其他账号' };
      return;
    }
    if (purpose === 'bind') {
      const userId = ctx.state.user.userId as number;
      if (await UserEmail.findByPk(userId)) {
        ctx.status = 409;
        ctx.body = { error: '账号已绑定邮箱' };
        return;
      }
      if (binding) {
        ctx.status = 409;
        ctx.body = { error: '该邮箱已绑定其他账号' };
        return;
      }
    }
    if (purpose === 'change-password') {
      const userId = ctx.state.user.userId as number;
      if (!(await UserEmail.findOne({ where: { userId, email } }))) {
        ctx.status = 400;
        ctx.body = { error: '请输入已绑定邮箱' };
        return;
      }
    }
    const result = await issueEmailCode(purpose, email);
    if (result === 'cooldown' && !anonymousPurpose) {
      ctx.status = 429;
      ctx.body = { error: '请稍后再发送验证码' };
      return;
    }
    ctx.body = { message: CODE_SENT_MESSAGE };
  } catch (error) {
    console.error('发送邮箱验证码失败:', error);
    if (purpose === 'reset' || purpose === 'login') {
      ctx.body = { message: CODE_SENT_MESSAGE };
      return;
    }
    ctx.status = 502;
    ctx.body = { error: '邮件发送失败，请稍后重试' };
  }
}

export const sendRegistrationCode = (ctx: Context) => issue(ctx, 'register');
export const sendResetCode = (ctx: Context) => issue(ctx, 'reset');
export const sendLoginCode = (ctx: Context) => issue(ctx, 'login');
export const sendBindCode = (ctx: Context) => issue(ctx, 'bind');
export const sendPasswordChangeCode = (ctx: Context) => issue(ctx, 'change-password');

export async function getEmailStatus(ctx: Context) {
  const binding = await UserEmail.findByPk(ctx.state.user.userId);
  ctx.body = { email: binding?.email || null };
}

export async function bindEmail(ctx: Context) {
  const userId = ctx.state.user.userId as number;
  const email = normalizeEmail((ctx.request.body as any)?.email);
  const code = (ctx.request.body as any)?.code;
  if (!email) {
    ctx.status = 400;
    ctx.body = { error: '请输入有效邮箱' };
    return;
  }
  if (await UserEmail.findByPk(userId)) {
    ctx.status = 409;
    ctx.body = { error: '账号已绑定邮箱' };
    return;
  }
  if (await UserEmail.findOne({ where: { email } })) {
    ctx.status = 409;
    ctx.body = { error: '该邮箱已绑定其他账号' };
    return;
  }
  if (!(await consumeEmailCode('bind', email, code))) {
    ctx.status = 400;
    ctx.body = { error: '验证码无效或已过期' };
    return;
  }
  try {
    const transaction = await User.sequelize!.transaction();
    try {
      await UserEmail.create({ userId, email, verifiedAt: new Date() }, { transaction });
      await User.update({ email }, { where: { id: userId }, transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    await redisService.delUserInfo(userId);
    ctx.body = { email, message: '邮箱绑定成功' };
  } catch (error) {
    console.error('绑定邮箱失败:', error);
    ctx.status = 409;
    ctx.body = { error: '邮箱已绑定或绑定失败' };
  }
}

export async function resetPassword(ctx: Context) {
  const email = normalizeEmail((ctx.request.body as any)?.email);
  const { code, newPassword } = ctx.request.body as any;
  if (!email) {
    ctx.status = 400;
    ctx.body = { error: '请输入有效邮箱' };
    return;
  }
  if (!isValidNewPassword(newPassword)) {
    ctx.status = 400;
    ctx.body = { error: PASSWORD_RULE_MESSAGE };
    return;
  }
  const binding = await UserEmail.findOne({ where: { email } });
  if (!binding || !(await consumeEmailCode('reset', email, code))) {
    ctx.status = 400;
    ctx.body = { error: '验证码无效或已过期' };
    return;
  }
  const user = await User.findByPk(binding.userId);
  if (!user) {
    ctx.status = 404;
    ctx.body = { error: '账号不存在' };
    return;
  }
  await replacePasswordAndRevokeSessions(user.id, hashPassword(newPassword), {
    authVersion: user.authVersion,
  });
  ctx.body = { message: '密码已重置，请重新登录' };
}
