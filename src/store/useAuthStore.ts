import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, LoginRequest, LoginResponse } from '../lib/api';
import { useTrackerStore } from './useTrackerStore';
import { logger } from '../lib/logger';
import { setSentryUser, clearSentryUser } from '../lib/sentry';

interface AuthState {
  user: LoginResponse['user'] | null;
  isAuthenticated: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
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
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('set_auth_tokens', {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
          }).catch((e) => {
            logger.error('AUTH', 'Failed to set tokens in Rust AuthManager', e);
            // Не блокируем логин, но логируем ошибку
          });
          
          // Обновляем состояние только после успешного сохранения токенов
          set({
            user: response.user,
            isAuthenticated: true,
          });
          
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
        // Reset tracker state
        await useTrackerStore.getState().reset();
        
        // PRODUCTION: Очищаем токены в Rust AuthManager
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_auth_tokens', {
          access_token: null,
          refresh_token: null,
        }).catch((e) => {
          logger.error('AUTH', 'Failed to clear tokens in Rust AuthManager', e);
        });
        
        // Clear tokens
        api.clearToken();
        localStorage.removeItem('refresh_token');
        
        // Очищаем пользователя в Sentry
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

