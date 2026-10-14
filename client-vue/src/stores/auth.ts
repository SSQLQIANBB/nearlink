import { defineStore } from 'pinia';
import {
  clearRemoteControlLocally,
  stopRemoteControlLocally,
} from '@/services/remoteControlSafety';
import type { PersistenceOptions } from 'pinia-plugin-persistedstate';
import type { LocationQueryRaw } from 'vue-router';
import {
  getCurrentUser,
  login as apiLogin,
  loginWithEmailCode as apiLoginWithEmailCode,
  logout as apiLogout,
  type LoginCredentials,
  type User,
} from '@/api/auth';

type LogoutOptions = {
  callApi?: boolean;
  redirect?: string;
  navigate?: boolean;
};

type CredentialLoginResult = {
  accessToken: string;
  refreshToken: string;
  user: User;
  message: string;
};

interface AuthState {
  currentUser: User | null;
  token: string | null;
  refreshToken: string | null;
  authGeneration: number;
  loggingOut: boolean;
}

const persistPrefix = '__STORAGE_PERSIST_AUTH_';

const persistOptions: PersistenceOptions<AuthState> = {
  storage: localStorage,
  key: persistPrefix,
  pick: ['token', 'refreshToken'],
};

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    currentUser: null,
    token: null,
    refreshToken: null,
    authGeneration: 0,
    loggingOut: false,
  }),

  getters: {
    isAuthenticated: (state) => !!state.token && !state.loggingOut,
  },

  actions: {
    setAuth(user: User, authToken: string, authRefreshToken?: string) {
      this.authGeneration++;
      this.loggingOut = false;
      clearRemoteControlLocally('AUTH_REPLACED');
      this.currentUser = user;
      this.token = authToken;

      if (authRefreshToken) {
        this.refreshToken = authRefreshToken;
      }
    },

    updateToken(newAccessToken: string, newRefreshToken?: string) {
      this.token = newAccessToken;

      if (newRefreshToken) {
        this.refreshToken = newRefreshToken;
      }
    },

    clearAuthLocal() {
      this.authGeneration++;
      this.loggingOut = false;
      clearRemoteControlLocally('AUTH_CLEARED');
      this.currentUser = null;
      this.token = null;
      this.refreshToken = null;
    },

    async fetchCurrentUser() {
      const generation = this.authGeneration;
      const { user } = await getCurrentUser({ skipAuthRedirect: true });
      if (generation !== this.authGeneration || this.loggingOut)
        throw new Error('Authentication changed during request');
      this.currentUser = user;
      return user;
    },

    async login(credentials?: LoginCredentials): Promise<CredentialLoginResult | { user: User }> {
      if (credentials) {
        // A login started during an older logout begins from an anonymous local state.
        if (this.loggingOut) this.clearAuthLocal();
        const generation = ++this.authGeneration;
        const result =
          'code' in credentials
            ? await apiLoginWithEmailCode(credentials)
            : await apiLogin(credentials);
        if (generation !== this.authGeneration)
          throw new Error('Authentication changed during login');
        this.setAuth(result.user, result.accessToken, result.refreshToken);
        return result;
      }

      const user = await this.fetchCurrentUser();
      return { user };
    },

    async logout(options: LogoutOptions = {}) {
      const { callApi = true, navigate = false, redirect } = options;
      const logoutToken = this.token;
      const generation = ++this.authGeneration;
      this.loggingOut = true;
      // Native stop is attempted before logout even when the network is unavailable.
      try {
        await stopRemoteControlLocally('LOGOUT');
      } catch (error) {
        console.error('Native remote control stop failed:', error);
      }

      if (callApi && logoutToken) {
        try {
          await apiLogout(logoutToken);
        } catch (error) {
          console.error('Logout request failed:', error);
        }
      }

      // A new successful login supersedes this logout, but the old sid was still revoked.
      if (generation !== this.authGeneration) return;
      this.clearAuthLocal();
      const clearedGeneration = this.authGeneration;

      if (navigate) {
        const { default: router } = await import('@/router');
        if (clearedGeneration !== this.authGeneration) return;
        const query: LocationQueryRaw = redirect ? { redirect } : {};
        await router.replace({ name: 'Login', query });
      }
    },

    async clearAuth() {
      await this.logout({ callApi: true });
    },

    updateUserInfo(user: Partial<User>) {
      if (this.currentUser) {
        this.currentUser = { ...this.currentUser, ...user };
      }
    },

    restoreUser(user: User) {
      this.currentUser = user;
    },
  },

  persist: persistOptions,
});
