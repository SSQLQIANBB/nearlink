import { useAuthStore } from '@/stores/auth';
import { pinia } from '@/stores';
import router from '@/router';
import { getAuthRedirect } from '@/services/authNavigation';
import { publicEnv } from '@/config/env';
import { createRequestId } from './requestId';

const API_BASE_URL = publicEnv.apiBaseUrl;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  signal?: AbortSignal;
  _retry?: boolean;
  _skipAuthRedirect?: boolean;
}

// 刷新token的Promise，用于防止并发刷新
let refreshTokenPromise: Promise<boolean> | null = null;
let refreshGeneration: number | null = null;
let refreshCredential: string | null = null;
let authFailurePromise: Promise<void> | null = null;
let authFailureHandled = false;

function skipsAutomaticAuthRecovery(url: string) {
  return [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh-token',
    '/api/auth/logout',
  ].some(path => url.startsWith(path));
}

/**
 * 刷新 access token
 */
export function refreshAccessToken(): Promise<boolean> {
  const auth = useAuthStore(pinia);
  if (refreshTokenPromise && refreshGeneration === auth.authGeneration && refreshCredential === auth.refreshToken) return refreshTokenPromise;
  refreshGeneration = auth.authGeneration;
  refreshCredential = auth.refreshToken;
  const operation = performTokenRefresh().finally(() => {
    if (refreshTokenPromise === operation) { refreshTokenPromise = null; refreshGeneration = null; refreshCredential = null; }
  });
  refreshTokenPromise = operation;
  return operation;
}

async function performTokenRefresh(): Promise<boolean> {
  const auth = useAuthStore(pinia);

  if (!auth.refreshToken || auth.loggingOut) {
    return false;
  }

  const originalGeneration = auth.authGeneration;
  const originalToken = auth.token;
  const originalRefreshToken = auth.refreshToken;
  const requestId = createRequestId();
  // A lost response may already have rotated the credential; retry that exact operation.
  const body = JSON.stringify({ refreshToken: originalRefreshToken, requestId });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (auth.loggingOut || auth.authGeneration !== originalGeneration || auth.token !== originalToken || auth.refreshToken !== originalRefreshToken) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const data = await response.json();
      // An in-flight refresh must not restore a logged-out or switched account.
      if (auth.loggingOut || auth.authGeneration !== originalGeneration || auth.token !== originalToken || auth.refreshToken !== originalRefreshToken) return false;
      if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') return false;
      auth.updateToken(data.accessToken, data.refreshToken);
      return true;
    } catch (error) {
      if (attempt === 1) console.error('Refresh token failed:', error);
    } finally { clearTimeout(timeout); }
  }
  return false;
}

async function handleAuthenticationFailure() {
  if (authFailurePromise) { await authFailurePromise; return; }
  const auth = useAuthStore(pinia);
  if (authFailureHandled) {
    if (!auth.token) return;
    // 已存在新的登录状态，后续 401 属于新的会话。
    authFailureHandled = false;
  }

  if (!authFailurePromise) {
    authFailureHandled = true;
    authFailurePromise = (async () => {
      const redirect = getAuthRedirect(router.currentRoute.value.fullPath);
      await auth.logout({ callApi: false, navigate: true, redirect });
    })().finally(() => {
      authFailurePromise = null;
    });
  }

  await authFailurePromise;
}

/**
 * 统一的HTTP请求方法
 */
export async function request<T = any>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    _retry = false,
    _skipAuthRedirect = false,
  } = options;
  const requestHeaders = { ...headers };

  const auth = useAuthStore(pinia);
  const requestGeneration = auth.authGeneration;
  if (auth.token && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${auth.token}`;
  }

  const isFormData = body instanceof FormData;

  if (!isFormData) {
    requestHeaders['Content-Type'] = requestHeaders['Content-Type'] || 'application/json';
  }

  const config: RequestInit = {
    method,
    headers: requestHeaders,
    signal: options.signal,
  };

  if (body && method !== 'GET') {
    config.body = isFormData ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${url}`, config);
    
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 && !skipsAutomaticAuthRecovery(url)) {
        options.signal?.throwIfAborted();
        if (auth.authGeneration !== requestGeneration || auth.loggingOut) throw new Error('Authentication changed during request');
        if (!_retry) {
          // HTTP and Socket authentication share one refresh operation/requestId.
          const refreshSuccess = await refreshAccessToken();
          options.signal?.throwIfAborted();
          if (auth.authGeneration !== requestGeneration || auth.loggingOut) throw new Error('Authentication changed during request');
          if (refreshSuccess) {
            // 刷新成功，重试原始请求
            return request<T>(url, { ...options, _retry: true });
          }
        }

        if (auth.authGeneration !== requestGeneration || auth.loggingOut) throw new Error('Authentication changed during request');
        if (_skipAuthRedirect) {
          throw new Error(data.error || 'Login expired, please sign in again');
        }
        await handleAuthenticationFailure();
        throw new Error('Login expired, please sign in again');
      }

      throw new Error(data.error || 'Request failed');
    }

    return data;
  } catch (error: any) {
    console.error('Request error:', error);
    throw error;
  }
}

// 便捷方法
export const http = {
  get: <T = any>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T = any>(url: string, body?: any) => request<T>(url, { method: 'POST', body }),
  put: <T = any>(url: string, body?: any) => request<T>(url, { method: 'PUT', body }),
  delete: <T = any>(url: string) => request<T>(url, { method: 'DELETE' }),
};
