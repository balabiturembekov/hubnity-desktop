import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, LoginRequest, LoginResponse } from '../lib/api';
import { setCurrentUser } from '../lib/current-user';
import { logger } from '../lib/logger';
import { setSentryUser, clearSentryUser } from '../lib/sentry';

interface AuthState {
  user: LoginResponse['user'] | null;
  isAuthenticated: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  clearTokens: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      
      login: async (credentials: LoginRequest) => {
        try {
          const response = await api.login(credentials);
          
          // FIX: Сохраняем токены ТОЛЬКО после успешного получения ответа
          // и перед обновлением состояния, чтобы избежать рассинхронизации
          api.setToken(response.access_token);
          localStorage.setItem('refresh_token', response.refresh_token);
          
          // PRODUCTION: Передаем токены в Rust AuthManager для синхронизации
          // Rust очистит локальные данные (таймер, очередь) если user_id изменился
          const { invoke } = await import('@tauri-apps/api/core');
          
          // Проверяем, сменился ли пользователь (до обновления состояния)
          const currentUserId = await invoke<string | null>('get_current_user_id').catch(() => null);
          const newUserId = String(response.user.id);
          const userChanged = currentUserId !== null && currentUserId !== newUserId;
          
          await invoke('set_auth_tokens', {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            userId: newUserId,
          }).catch((e) => {
            logger.error('AUTH', 'Failed to set tokens in Rust AuthManager', e);
            // Не блокируем логин, но логируем ошибку
          });
          
          // Очищаем состояние трекера при смене пользователя
          // Rust уже очистил таймер и очередь, но фронтенд хранит проекты и активный time entry
          if (userChanged) {
            const { useTrackerStore } = await import('./useTrackerStore');
            await useTrackerStore.getState().reset();
          }
          
          // Обновляем состояние только после успешного сохранения токенов
          set({
            user: response.user,
            isAuthenticated: true,
          });
          setCurrentUser(response.user);

          // Устанавливаем пользователя в Sentry для контекста ошибок
          setSentryUser({
            id: response.user.id,
            email: response.user.email,
          });
        } catch (error) {
          // If login fails, ensure tokens are cleared
          // This prevents tokens from remaining in localStorage without authenticated user
          api.clearToken();
          throw error; // Re-throw to let Login component handle it
        }
      },
      logout: async () => {
        const refreshToken = localStorage.getItem('refresh_token');
        const accessToken = api.getAccessToken();
        try {
          if (accessToken) {
            await api.logout(refreshToken ?? undefined);
          }
        } catch (e) {
          logger.warn('AUTH', 'Logout API call failed (clearing local state anyway)', e);
        }
        setCurrentUser(null);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_auth_tokens', {
          accessToken: null,
          refreshToken: null,
          userId: null,
        }).catch((e) => {
          logger.error('AUTH', 'Failed to clear tokens in Rust AuthManager', e);
        });
        api.clearToken();
        localStorage.removeItem('refresh_token');
        clearSentryUser();
        set({
          user: null,
          isAuthenticated: false,
        });
      },
      clearTokens: async () => {
        const refreshToken = localStorage.getItem('refresh_token');
        try {
          if (api.getAccessToken()) {
            await api.logout(refreshToken ?? undefined);
          }
        } catch (e) {
          logger.warn('AUTH', 'clearTokens: logout API failed', e);
        }
        setCurrentUser(null);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_auth_tokens', {
          accessToken: null,
          refreshToken: null,
          userId: null,
        }).catch((e) => {
          logger.error('AUTH', 'Failed to clear tokens in Rust AuthManager', e);
        });
        api.clearToken();
        localStorage.removeItem('refresh_token');
        clearSentryUser();
        set({
          user: null,
          isAuthenticated: false,
        });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);

