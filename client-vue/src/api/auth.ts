import { http, request } from '@/utils/request';

export interface User {
  id: number;
  username: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  bio?: string;
  status?: 'online' | 'offline' | 'busy';
}

export interface LoginParams {
  username: string;
  password: string;
}

export interface EmailCodeLoginParams {
  email: string;
  code: string;
}

export type LoginCredentials = LoginParams | EmailCodeLoginParams;

export interface RegisterParams {
  username: string;
  password: string;
  nickname?: string;
  email: string;
  emailCode: string;
  phone?: string;
}

/**
 * 用户登录
 */
export function login(params: LoginParams) {
  return http.post<{ accessToken: string; refreshToken: string; user: User; message: string }>(
    '/api/auth/login',
    params,
  );
}

export function loginWithEmailCode(params: EmailCodeLoginParams) {
  return http.post<{ accessToken: string; refreshToken: string; user: User; message: string }>(
    '/api/auth/login/email-code',
    params,
  );
}

/**
 * 用户注册
 */
export function register(params: RegisterParams) {
  return http.post<{ accessToken: string; refreshToken: string; user: User; message: string }>(
    '/api/auth/register',
    params,
  );
}

/**
 * 刷新 access token
 */
export function refreshAccessToken(refreshToken: string) {
  return http.post<{ accessToken: string; refreshToken: string; message: string }>(
    '/api/auth/refresh-token',
    { refreshToken },
  );
}

/**
 * 获取当前用户信息
 */
export function getCurrentUser(options?: { skipAuthRedirect?: boolean }) {
  return request<{ user: User }>('/api/auth/me', {
    _skipAuthRedirect: options?.skipAuthRedirect,
  });
}

export type EmailCodePurpose = 'register' | 'reset' | 'bind' | 'change-password' | 'login';

export function sendEmailCode(purpose: EmailCodePurpose, email: string) {
  return http.post<{ message: string }>(`/api/auth/email-code/${purpose}`, { email });
}

export function resetPassword(email: string, code: string, newPassword: string) {
  return http.post<{ message: string }>('/api/auth/reset-password', { email, code, newPassword });
}

export function getVerifiedEmail() {
  return http.get<{ email: string | null }>('/api/auth/email');
}

export function bindEmail(email: string, code: string) {
  return http.post<{ email: string; message: string }>('/api/auth/bind-email', { email, code });
}

/**
 * 更新用户信息
 */
export function updateUser(data: Partial<User>) {
  return http.put<{ user: User; message: string }>('/api/auth/me', data);
}

/**
 * 获取用户列表
 */
export function getUserList() {
  return http.get<{ users: User[] }>('/api/auth/users');
}

/**
 * 用户登出
 */
export function logout(accessToken?: string) {
  return request<{ message: string }>('/api/auth/logout', {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
}

/**
 * 修改密码
 */
export function changePassword(oldPassword: string, newPassword: string, emailCode: string) {
  return http.post<{ message: string }>('/api/auth/change-password', {
    oldPassword,
    newPassword,
    emailCode,
  });
}
