import { Context } from 'koa';
import { User, UserEmail } from '../models';
import { hashPassword, verifyPassword } from '../utils/crypto';
import {
  createLoginSession,
  rotateLoginSession,
  revokeLoginSession,
  hasActiveLoginSessions,
  replacePasswordAndRevokeSessions,
  InvalidLoginSessionError,
} from '../services/loginSessionService';
import redisService from '../services/redisService';
import { consumeEmailCode, normalizeEmail } from '../services/emailVerificationService';
import { isValidNewPassword, PASSWORD_RULE_MESSAGE } from '../utils/passwordPolicy';

/**
 * 用户注册
 */
export async function register(ctx: Context) {
  try {
    const {
      username,
      password,
      nickname,
      email: rawEmail,
      emailCode,
      phone,
    } = ctx.request.body as any;
    const email = normalizeEmail(rawEmail);

    // 验证必填字段
    if (!username || !email) {
      ctx.status = 400;
      ctx.body = { error: '请输入用户名和有效邮箱' };
      return;
    }
    if (!isValidNewPassword(password)) {
      ctx.status = 400;
      ctx.body = { error: PASSWORD_RULE_MESSAGE };
      return;
    }

    // 检查用户名是否已存在
    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) {
      ctx.status = 400;
      ctx.body = { error: '用户名已存在' };
      return;
    }
    if (await UserEmail.findOne({ where: { email } })) {
      ctx.status = 409;
      ctx.body = { error: '该邮箱已绑定其他账号' };
      return;
    }
    if (!(await consumeEmailCode('register', email, emailCode))) {
      ctx.status = 400;
      ctx.body = { error: '邮箱验证码无效或已过期' };
      return;
    }

    // 创建用户
    const hashedPassword = hashPassword(password);
    const transaction = await User.sequelize!.transaction();
    let user: User;
    try {
      user = await User.create(
        {
          username,
          password: hashedPassword,
          nickname: nickname || username,
          email,
          phone,
          status: 'online',
        },
        { transaction },
      );
      await UserEmail.create({ userId: user.id, email, verifiedAt: new Date() }, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    const tokens = await createLoginSession(user.id, { authVersion: user.authVersion });

    ctx.body = {
      message: '注册成功',
      loginSessionId: tokens.loginSessionId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        username: username,
        nickname: nickname || username,
        avatar: null,
        email,
        phone: phone || null,
        status: 'online',
      },
    };
  } catch (error: any) {
    console.error('注册失败:', error);
    ctx.status = 500;
    ctx.body = { error: '注册失败，请稍后重试' };
  }
}

async function completeLogin(ctx: Context, user: User) {
  const userData = user.get({ plain: true });
  await user.update({ lastLoginAt: new Date(), status: 'online' });
  const tokens = await createLoginSession(userData.id!, {
    authVersion: userData.authVersion,
    password: userData.password,
  });
  ctx.body = {
    message: '登录成功',
    loginSessionId: tokens.loginSessionId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: {
      id: userData.id,
      username: userData.username,
      nickname: userData.nickname,
      avatar: userData.avatar,
      email: (await UserEmail.findByPk(user.id))?.email || null,
      phone: user.phone,
      status: user.status,
    },
  };
}

/** 用户名或已验证邮箱 + 密码登录 */
export async function login(ctx: Context) {
  try {
    const { username, password } = ctx.request.body as any;
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      typeof password !== 'string' ||
      !password
    ) {
      ctx.status = 400;
      ctx.body = { error: '请输入账号和密码' };
      return;
    }

    const account = username;
    const email = normalizeEmail(account);
    // 优先保留原有用户名的含义；找不到用户名时再用已验证邮箱定位账号。
    let user = await User.findOne({ where: { username: account } });
    if (!user && email) {
      const binding = await UserEmail.findOne({ where: { email } });
      if (binding) user = await User.findByPk(binding.userId);
    }
    if (!user || !verifyPassword(password, user.get({ plain: true }).password)) {
      ctx.status = 401;
      ctx.body = { error: '账号或密码错误' };
      return;
    }
    await completeLogin(ctx, user);
  } catch (error: any) {
    console.error('登录失败:', error);
    ctx.status = 500;
    ctx.body = { error: '登录失败: ' + error.message };
  }
}

/** 已验证邮箱 + 验证码登录 */
export async function loginWithEmailCode(ctx: Context) {
  try {
    const email = normalizeEmail((ctx.request.body as any)?.email);
    const code = (ctx.request.body as any)?.code;
    if (!email || typeof code !== 'string') {
      ctx.status = 400;
      ctx.body = { error: '请输入有效邮箱和验证码' };
      return;
    }
    const binding = await UserEmail.findOne({ where: { email } });
    if (!binding || !(await consumeEmailCode('login', email, code))) {
      ctx.status = 401;
      ctx.body = { error: '邮箱或验证码错误' };
      return;
    }
    const user = await User.findByPk(binding.userId);
    if (!user) {
      ctx.status = 401;
      ctx.body = { error: '邮箱或验证码错误' };
      return;
    }
    await completeLogin(ctx, user);
  } catch (error) {
    console.error('邮箱验证码登录失败:', error);
    ctx.status = 500;
    ctx.body = { error: '登录失败，请稍后重试' };
  }
}

/**
 * 获取当前用户信息
 */
export async function getCurrentUser(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;

    // 先尝试从Redis获取
    let userData = await redisService.getUserInfo(userId);

    if (!userData) {
      // Redis中没有，从数据库获取
      const user = await User.findByPk(userId);
      if (!user) {
        ctx.status = 404;
        ctx.body = { error: '用户不存在' };
        return;
      }

      userData = user.get({ plain: true });

      // 缓存到Redis
      await redisService.setUserInfo(userId, {
        id: userData.id,
        username: userData.username,
        nickname: userData.nickname,
        avatar: userData.avatar,
        email: userData.email,
        phone: userData.phone,
        status: userData.status,
        bio: userData.bio,
      });
    }

    const verifiedEmail = await UserEmail.findByPk(userId);
    ctx.body = {
      user: {
        id: userData.id,
        username: userData.username,
        nickname: userData.nickname,
        avatar: userData.avatar,
        email: verifiedEmail?.email || null,
        phone: userData.phone,
        status: userData.status,
        bio: userData.bio,
      },
    };
  } catch (error: any) {
    console.error('获取用户信息失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取用户信息失败: ' + error.message };
  }
}

/**
 * 更新用户信息
 */
export async function updateUser(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { nickname, email, phone, avatar, bio, status } = ctx.request.body as any;
    if (email !== undefined) {
      ctx.status = 400;
      ctx.body = { error: '请通过邮箱验证入口绑定邮箱' };
      return;
    }

    const user = await User.findByPk(userId);
    if (!user) {
      ctx.status = 404;
      ctx.body = { error: '用户不存在' };
      return;
    }

    // 更新用户信息
    const updateData: any = {};
    if (nickname !== undefined) updateData.nickname = nickname;
    if (phone !== undefined) updateData.phone = phone;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (bio !== undefined) updateData.bio = bio;
    if (status !== undefined) updateData.status = status;

    await user.update(updateData);

    const userData = user.get({ plain: true });

    // 更新Redis缓存
    await redisService.setUserInfo(userId, {
      id: userData.id,
      username: userData.username,
      nickname: userData.nickname,
      avatar: userData.avatar,
      email: (await UserEmail.findByPk(userId))?.email || null,
      phone: userData.phone,
      bio: userData.bio,
      status: userData.status,
    });

    ctx.body = {
      message: '更新成功',
      user: {
        id: userData.id,
        username: userData.username,
        nickname: userData.nickname,
        avatar: userData.avatar,
        email: (await UserEmail.findByPk(userId))?.email || null,
        phone: userData.phone,
        bio: userData.bio,
        status: userData.status,
      },
    };
  } catch (error: any) {
    console.error('更新用户信息失败:', error);
    ctx.status = 500;
    ctx.body = { error: '更新用户信息失败: ' + error.message };
  }
}

/**
 * 获取用户列表
 */
export async function getUserList(ctx: Context) {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'nickname', 'avatar', 'status'],
    });

    ctx.body = { users };
  } catch (error: any) {
    console.error('获取用户列表失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取用户列表失败: ' + error.message };
  }
}

/**
 * 用户登出
 */
export async function logout(ctx: Context) {
  try {
    const { userId, sid } = ctx.state.user;
    await revokeLoginSession(userId, sid);
    if (!(await hasActiveLoginSessions(userId))) {
      await User.update({ status: 'offline' }, { where: { id: userId } });
      await redisService.setUserStatus(userId, 'offline');
      await redisService.delUserSocket(userId);
    }
    ctx.body = { message: '登出成功' };
  } catch (error) {
    console.error('登出失败:', error);
    ctx.status = 500;
    ctx.body = { error: '登出失败，请稍后重试' };
  }
}

/** Refresh one login session without disturbing another device. */
export async function refreshToken(ctx: Context) {
  const { refreshToken: clientRefreshToken, requestId } = (ctx.request.body || {}) as any;
  if (typeof clientRefreshToken !== 'string' || !clientRefreshToken) {
    ctx.status = 400;
    ctx.body = { error: 'refresh token 不能为空' };
    return;
  }
  if (
    requestId !== undefined &&
    (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId))
  ) {
    ctx.status = 400;
    ctx.body = { error: '无效的刷新 requestId' };
    return;
  }
  try {
    const tokens = await rotateLoginSession(clientRefreshToken, requestId);
    ctx.body = { message: 'token 刷新成功', ...tokens };
  } catch (error) {
    ctx.status = 401;
    ctx.body = { error: 'refresh token 无效或登录会话已失效' };
  }
}

/**
 * 修改密码
 */
export async function changePassword(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { oldPassword, newPassword, emailCode } = ctx.request.body as any;

    if (!oldPassword) {
      ctx.status = 400;
      ctx.body = { error: '请输入当前密码' };
      return;
    }
    if (!isValidNewPassword(newPassword)) {
      ctx.status = 400;
      ctx.body = { error: PASSWORD_RULE_MESSAGE };
      return;
    }

    const user = await User.findByPk(userId);
    if (!user) {
      ctx.status = 404;
      ctx.body = { error: '用户不存在' };
      return;
    }

    // 验证旧密码
    if (!verifyPassword(oldPassword, user.password)) {
      ctx.status = 401;
      ctx.body = { error: '旧密码错误' };
      return;
    }

    const binding = await UserEmail.findByPk(userId);
    if (!binding) {
      ctx.status = 400;
      ctx.body = { error: '请先绑定并验证邮箱' };
      return;
    }
    if (!(await consumeEmailCode('change-password', binding.email, emailCode))) {
      ctx.status = 400;
      ctx.body = { error: '邮箱验证码无效或已过期' };
      return;
    }

    // 更新密码
    const hashedPassword = hashPassword(newPassword);
    await replacePasswordAndRevokeSessions(userId, hashedPassword, {
      password: user.password,
      authVersion: user.authVersion,
    });

    ctx.body = {
      message: '密码修改成功',
    };
  } catch (error: any) {
    console.error('修改密码失败:', error);
    ctx.status = error instanceof InvalidLoginSessionError ? 401 : 500;
    ctx.body = { error: '修改密码失败: ' + error.message };
  }
}
