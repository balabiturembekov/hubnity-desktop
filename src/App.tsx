import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { useTrackerStore } from './store/useTrackerStore';
import { Login } from './components/Login';
import { ProjectSelector } from './components/ProjectSelector';
import { TimerWithScreenshots } from './components/Timer';
import { Settings } from './components/Settings';
import { SyncIndicator } from './components/SyncIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { invoke } from '@tauri-apps/api/core';
import type { Update } from '@tauri-apps/plugin-updater';
import { listen } from '@tauri-apps/api/event';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Button } from './components/ui/button';
import { LogOut } from 'lucide-react';
import { logger } from './lib/logger';
import { setSentryUser } from './lib/sentry';
import { setCurrentUser } from './lib/current-user';
import { USER_ROLES } from './lib/api';
import './App.css';

function App() {
  const { isAuthenticated, user, logout } = useAuthStore();
  const { loadActiveTimeEntry, reset } = useTrackerStore();
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body?: string } | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);

  // Восстанавливаем токены в Rust AuthManager — иначе фоновая синхронизация всегда получает "token not set" и Синхронизировано = 0
  const restoreTokens = useCallback(async () => {
    const { api } = await import('./lib/api');
    const accessToken = api.getAccessToken() || localStorage.getItem('access_token');
    const refreshToken = localStorage.getItem('refresh_token');

    if (accessToken) {
      try {
        const { user } = useAuthStore.getState();
        await invoke('set_auth_tokens', {
          accessToken,
          refreshToken,
          userId: user ? String(user.id) : null,
        });
        logger.info('APP', 'Tokens restored in Rust AuthManager');
        setCurrentUser(user ?? null);
        if (user) {
          setSentryUser({ id: user.id, email: user.email });
        }
      } catch (e) {
        logger.error('APP', 'Failed to restore tokens in Rust AuthManager', e);
      }
    } else {
      setCurrentUser(null);
      // Не вызываем set_auth_tokens(null) здесь — иначе спам в логах. Очистка только при logout().
    }
  }, [isAuthenticated]);

  // Восстанавливаем токены при монтировании и при смене isAuthenticated
  useEffect(() => {
    restoreTokens();
    const t = setTimeout(restoreTokens, 2000);
    return () => clearTimeout(t);
  }, [restoreTokens]);

  // Критично: каждые 30 с передаём токены в Rust (если есть) и запускаем синхронизацию.
  // Не полагаемся на isAuthenticated — токен может быть в localStorage до регидрации Zustand.
  useEffect(() => {
    const pushTokensAndSync = async () => {
      try {
        const { api } = await import('./lib/api');
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token');
        const refreshToken = localStorage.getItem('refresh_token');
        await logger.safeLogToRust(`[SYNC-FRONT] pushTokensAndSync: hasToken=${!!accessToken}`).catch(() => {});
        if (!accessToken) return;
        const { user } = useAuthStore.getState();
        await invoke('set_auth_tokens', {
          accessToken,
          refreshToken,
          userId: user ? String(user.id) : null,
        });
        const synced = await invoke<number>('sync_queue_now');
        await logger.safeLogToRust(`[SYNC-FRONT] sync_queue_now returned: ${synced}`).catch(() => {});
        if (synced > 0) logger.info('APP', `Sync: ${synced} task(s) sent`);
      } catch (e) {
        logger.warn('APP', 'pushTokensAndSync failed', e);
        await logger.safeLogToRust(`[SYNC-FRONT] pushTokensAndSync error: ${String(e)}`).catch(() => {});
      }
    };
    pushTokensAndSync();
    const early = setTimeout(pushTokensAndSync, 3000);
    const interval = setInterval(pushTokensAndSync, 30_000);
    return () => {
      clearTimeout(early);
      clearInterval(interval);
    };
  }, []);

  // CRITICAL FIX: Сохраняем состояние таймера при закрытии приложения
  // ДОКАЗАНО: Tauri window close event обрабатывается в Rust (синхронно)
  // Дополнительно: beforeunload handler как fallback
  useEffect(() => {
    const handleBeforeUnload = async () => {
      try {
        // Дополнительная защита: пытаемся сохранить состояние
        // ДОКАЗАНО: Основное сохранение происходит через Tauri window close event в Rust
        await useTrackerStore.getState().saveTimerState();
      } catch (error) {
        logger.error('APP', 'Failed to save timer state on close (fallback)', error);
        // ДОКАЗАНО: Ошибка не критична, так как Rust handler уже сохранил состояние
      }
    };

    // Обработчик для браузерного beforeunload (дополнительная защита)
    // ДОКАЗАНО: Основное сохранение происходит через Tauri window close event
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Initialize system tray on mount
  useEffect(() => {
    const initTray = async () => {
      try {
        // Create system tray using Tauri command
        // First, try to get existing tray or create new one
        const { invoke } = await import('@tauri-apps/api/core');
        
        // Create tray menu items
        const menuItems = [
          { id: 'show', text: 'Показать' },
          { id: 'hide', text: 'Скрыть' },
          { id: 'separator', text: '' },
          { id: 'quit', text: 'Выход' },
        ];

        // Try to create tray if it doesn't exist
        try {
          await invoke('plugin:tray|new', {
            id: 'main',
            menu: menuItems,
          });
        } catch (err) {
          // Tray might already exist, or we need to use a different approach
          logger.debug('APP', 'Tray creation failed (non-critical)', err);
        }

        // Set initial tooltip
        try {
          await invoke('plugin:tray|set_tooltip', {
            id: 'main',
            tooltip: '⏹ 00:00:00',
          });
        } catch (err) {
          logger.debug('APP', 'Tray tooltip failed (non-critical)', err);
        }
      } catch (error) {
        logger.error('APP', 'Failed to initialize system tray', error);
      }
    };
    initTray();
  }, []);

  // Request screenshot permission on mount
  useEffect(() => {
    const requestPermission = async () => {
      try {
        const hasPermission = await invoke<boolean>('request_screenshot_permission');
        if (!hasPermission) {
          // Show notification to grant permission
          // Message is platform-agnostic - Windows usually doesn't require explicit permission,
          // but if screenshots fail, user may need to run as admin or check system settings
          await invoke('show_notification', {
            title: 'Проверка разрешений',
            body: 'Не удалось получить доступ к скриншотам. Убедитесь, что приложение имеет необходимые права доступа.',
          });
        }
      } catch (error) {
        logger.error('APP', 'Failed to request screenshot permission', error);
      }
    };
    requestPermission();
  }, []);

  // Load active time entry on mount if authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadActiveTimeEntry().catch((error) => {
        // Silently handle errors - active entry might not exist or network might be down
        logger.error('APP', 'Failed to load active time entry', error);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]); // loadActiveTimeEntry is stable from zustand, but we don't want to re-run on every render

  // Периодическая синхронизация состояния таймера с сервера (для мультиустройств)
  // Проверяем каждые 10 секунд, чтобы синхронизировать паузу/возобновление с других устройств
  useEffect(() => {
    if (!isAuthenticated) return;

    const syncTimerState = async () => {
      try {
        const { currentTimeEntry, isTracking } = useTrackerStore.getState();
        
        // Если локально нет активной записи и таймер остановлен, не нужно синхронизировать
        if (!currentTimeEntry && !isTracking) {
          return;
        }
        
        const { api } = await import('./lib/api');
        const activeEntries = await api.getActiveTimeEntries();
        
        if (activeEntries.length > 0) {
          const activeEntry = activeEntries[0];
          const { getTimerState, currentTimeEntry: currentEntry } = useTrackerStore.getState();
          
          // Если нет currentTimeEntry, не синхронизируем остановку (уже остановлено локально)
          if (!currentEntry) {
            return;
          }
          
          const timerState = await getTimerState();
          
          // Синхронизируем состояние таймера с сервером
          if (activeEntry.status === 'RUNNING' && timerState.state !== 'RUNNING') {
            // На сервере RUNNING, но локально не RUNNING - запускаем
            logger.info('APP', 'Syncing timer: server is RUNNING, starting local timer');
            const { resumeTracking } = useTrackerStore.getState();
            await resumeTracking().catch((e) => {
              logger.warn('APP', 'Failed to resume timer on sync', e);
            });
          } else if (activeEntry.status === 'PAUSED' && timerState.state === 'RUNNING') {
            // На сервере PAUSED, но локально RUNNING - ставим на паузу
            logger.info('APP', 'Syncing timer: server is PAUSED, pausing local timer');
            const { pauseTracking } = useTrackerStore.getState();
            await pauseTracking().catch((e) => {
              logger.warn('APP', 'Failed to pause timer on sync', e);
            });
          } else if (activeEntry.status === 'STOPPED' && timerState.state !== 'STOPPED') {
            // На сервере STOPPED, но локально не STOPPED - останавливаем
            // currentEntry уже проверен выше
            logger.info('APP', 'Syncing timer: server is STOPPED, stopping local timer');
            const { stopTracking } = useTrackerStore.getState();
            await stopTracking().catch((e) => {
              logger.warn('APP', 'Failed to stop timer on sync', e);
            });
          }
        } else {
          // Нет активных записей на сервере, но локально таймер работает - останавливаем
          // Проверяем, что есть currentTimeEntry перед остановкой
          const { currentTimeEntry: currentEntry, getTimerState } = useTrackerStore.getState();
          if (!currentEntry) {
            return; // Уже остановлено локально
          }
          const timerState = await getTimerState();
          if (timerState.state !== 'STOPPED') {
            logger.info('APP', 'Syncing timer: no active entries on server, stopping local timer');
            const { stopTracking } = useTrackerStore.getState();
            await stopTracking().catch((e) => {
              logger.warn('APP', 'Failed to stop timer on sync', e);
            });
          }
        }
      } catch (error) {
        logger.debug('APP', 'Failed to sync timer state from server', error);
        // Не логируем как ошибку - это нормально если сервер недоступен
      }
    };

    // Первая проверка через 30 секунд (не останавливать только что восстановленный таймер сразу)
    const initialTimeout = setTimeout(syncTimerState, 30000);
    // Затем каждые 10 секунд
    const interval = setInterval(syncTimerState, 10000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  // Listen for auth logout events (from refresh token failure)
  useEffect(() => {
    const handleLogout = async () => {
      try {
        await useAuthStore.getState().logout();
        await useTrackerStore.getState().reset();
      } catch (error) {
        await useAuthStore.getState().clearTokens();
      }
    };

    window.addEventListener('auth:logout', handleLogout);
    return () => {
      window.removeEventListener('auth:logout', handleLogout);
    };
  }, []);

  // Проверка обновлений (раз в 15 с после загрузки, затем не спамим)
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (cancelled || !update) return;
        pendingUpdateRef.current = update;
        setUpdateAvailable({ version: update.version, body: update.body ?? undefined });
        await invoke('show_notification', {
          title: 'Hubnity',
          body: `Доступна новая версия ${update.version}. Откройте приложение и нажмите «Установить».`,
        }).catch(() => {});
      } catch (e) {
        logger.debug('APP', 'Update check failed (non-critical)', e);
      }
    }, 15000);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      logger.error('APP', 'Update install failed', e);
      await invoke('show_notification', {
        title: 'Hubnity',
        body: 'Не удалось установить обновление. Попробуйте скачать с сайта.',
      }).catch(() => {});
    }
  }, []);

  // Setup activity monitoring listeners and heartbeat
  useEffect(() => {
    if (!isAuthenticated) return;

    let unlistenActivity: (() => void) | null = null;
    let idleCheckInterval: NodeJS.Timeout | null = null;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    let isCleanedUp = false;

    const setupActivityListeners = async () => {
      // Listen for activity events from Rust
      try {
        unlistenActivity = await listen('activity-detected', () => {
          logger.safeLogToRust('[ACTIVITY] Event received from Rust').catch((e) => {
            logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
          });
          useTrackerStore.getState().updateActivityTime();
        });
        await logger.safeLogToRust('[ACTIVITY] Activity listener set up successfully').catch((e) => {
          logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
        });
      } catch (error) {
        logger.error('ACTIVITY', 'Failed to setup activity listener', error);
        await logger.safeLogToRust(`[ACTIVITY] Failed to setup listener: ${error}`).catch((e) => {
          logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
        });
      }

      // Check idle status every 30 seconds
      idleCheckInterval = setInterval(() => {
        if (!isCleanedUp) {
          useTrackerStore.getState().checkIdleStatus();
        }
      }, 30000);

      heartbeatInterval = setInterval(async () => {
        if (!isCleanedUp) {
          try {
            const timerState = await useTrackerStore.getState().getTimerState();
            if (timerState.state === 'RUNNING') {
              await useTrackerStore.getState().sendHeartbeat(true);
            }
          } catch (error) {
            logger.error('APP', 'Failed to send heartbeat', error);
          }
        }
      }, 60000);
    };

    setupActivityListeners();

    return () => {
      isCleanedUp = true;
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      if (unlistenActivity) {
        unlistenActivity();
      }
    };
  }, [isAuthenticated]); // Removed checkIdleStatus and updateActivityTime from dependencies

  // Setup URL activity tracking
  useEffect(() => {
    if (!isAuthenticated) return;

    let isCleanedUp = false;
    let urlTrackingInterval: NodeJS.Timeout | null = null;
    let urlSendInterval: NodeJS.Timeout | null = null;
    
    // Track current URL and time spent
    let currentUrl: string | null = null;
    let currentDomain: string | null = null;
    let currentTitle: string | null = null;
    let urlStartTime: number | null = null;
    const minUrlTimeSeconds = 5; // Minimum time (5 seconds) to track a URL

    // Helper function to extract domain from URL
    const extractDomain = (url: string): string | null => {
      try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, ''); // Remove www. prefix
      } catch {
        // If URL parsing fails, try simple extraction
        if (url.startsWith('http://')) {
          const withoutProtocol = url.substring(7);
          const domain = withoutProtocol.split('/')[0];
          return domain.replace(/^www\./, '');
        }
        if (url.startsWith('https://')) {
          const withoutProtocol = url.substring(8);
          const domain = withoutProtocol.split('/')[0];
          return domain.replace(/^www\./, '');
        }
        return null;
      }
    };

    // Helper function to save current URL activity
    const saveCurrentUrlActivity = async (timeEntryId: string, minTime: number = 0) => {
      if (currentUrl !== null && urlStartTime !== null && currentDomain) {
        const timeSpent = Math.floor((Date.now() - urlStartTime) / 1000);
        
        // Save if time spent meets minimum threshold
        if (timeSpent >= minTime) {
          useTrackerStore.getState().addUrlActivity({
            timeEntryId,
            url: currentUrl,
            domain: currentDomain,
            title: currentTitle || currentUrl,
            timeSpent,
          });
          
          await logger.safeLogToRust(`[URL TRACKING] Saved: ${currentDomain} (${timeSpent}s)`).catch((e) => {
            logger.debug('URL_TRACKING', 'Failed to log (non-critical)', e);
          });
        }
      }
    };

    const trackUrlActivity = async () => {
      if (isCleanedUp) return;
      
      const { currentTimeEntry } = useTrackerStore.getState();
      let isTracking = false;
      let isPaused = false;

      try {
        const timerState = await useTrackerStore.getState().getTimerState();
        isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
        isPaused = timerState.state === 'PAUSED';
      } catch (error) {
        const storeState = useTrackerStore.getState();
        isTracking = storeState.isTracking;
        isPaused = storeState.isPaused;
      }
      
      // Only track if tracking is active and not paused
      if (!isTracking || isPaused || !currentTimeEntry) {
        // Save current URL activity before resetting (if tracking was active)
        if (currentUrl !== null && currentTimeEntry) {
          await saveCurrentUrlActivity(currentTimeEntry.id, minUrlTimeSeconds);
        }
        
        // Reset tracking if not tracking
        if (currentUrl !== null) {
          currentUrl = null;
          currentDomain = null;
          currentTitle = null;
          urlStartTime = null;
        }
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const windowInfo = await invoke<{
          app_name: string | null;
          window_title: string | null;
          url: string | null;
          domain: string | null;
        }>('get_active_window_info').catch(() => {
          // If get_active_window_info fails (e.g., Objective-C exception), return empty info
          // Silently fail - function is temporarily disabled
          return {
            app_name: null,
            window_title: null,
            url: null,
            domain: null,
          };
        });

        // Check if it's a browser (common browser names)
        const browserNames = ['Safari', 'Google Chrome', 'Chrome', 'Firefox', 'Microsoft Edge', 'Opera', 'Brave Browser', 'Arc', 'Vivaldi'];
        const isBrowser = windowInfo.app_name && browserNames.some(name => 
          windowInfo.app_name?.toLowerCase().includes(name.toLowerCase())
        );

        if (!isBrowser) {
          // Not a browser - save current URL activity before resetting
          if (currentUrl !== null && currentTimeEntry) {
            await saveCurrentUrlActivity(currentTimeEntry.id, minUrlTimeSeconds);
          }
          
          // Reset tracking
          if (currentUrl !== null) {
            currentUrl = null;
            currentDomain = null;
            currentTitle = null;
            urlStartTime = null;
          }
          return;
        }

        // Extract URL and domain
        const url = windowInfo.url || null;
        const domain = windowInfo.domain || (url ? extractDomain(url) : null);
        const title = windowInfo.window_title || null;

        // If URL changed, save previous URL activity
        // Save even if time is less than minUrlTimeSeconds when URL changes (to avoid data loss)
        if (currentUrl !== null && currentUrl !== url && urlStartTime !== null && currentDomain) {
          await saveCurrentUrlActivity(currentTimeEntry.id, 1); // Minimum 1 second when URL changes
        }

        // Update current URL tracking
        if (url && domain) {
          if (currentUrl !== url) {
            // URL changed - start tracking new URL
            currentUrl = url;
            currentDomain = domain;
            currentTitle = title;
            urlStartTime = Date.now();
          }
          // URL is the same - continue tracking (time will be accumulated)
        } else {
          // No valid URL - save current URL activity before resetting
          if (currentUrl !== null && currentTimeEntry) {
            await saveCurrentUrlActivity(currentTimeEntry.id, minUrlTimeSeconds);
          }
          
          // Reset tracking
          if (currentUrl !== null) {
            currentUrl = null;
            currentDomain = null;
            currentTitle = null;
            urlStartTime = null;
          }
        }
      } catch (error) {
        // Silently handle errors - window info might not be available
        logger.error('APP', 'Failed to track URL activity', error);
      }
    };

    const sendUrlActivities = async () => {
      if (isCleanedUp) return;
      
      let isTracking = false;
      let isPaused = false;

      try {
        const timerState = await useTrackerStore.getState().getTimerState();
        isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
        isPaused = timerState.state === 'PAUSED';
      } catch (error) {
        const storeState = useTrackerStore.getState();
        isTracking = storeState.isTracking;
        isPaused = storeState.isPaused;
      }
      
      // Only send if tracking is active and not paused
      if (isTracking && !isPaused) {
        try {
          await useTrackerStore.getState().sendUrlActivities();
        } catch (error) {
          logger.error('APP', 'Failed to send URL activities', error);
        }
      }
    };

    // Track URL activity every 5 seconds
    urlTrackingInterval = setInterval(() => {
      if (!isCleanedUp) {
        trackUrlActivity();
      }
    }, 5000); // 5 seconds

    // Send accumulated URL activities every minute
    urlSendInterval = setInterval(() => {
      if (!isCleanedUp) {
        sendUrlActivities();
      }
    }, 60000); // 1 minute

    // Initial track - delay to avoid calling too early (may cause Objective-C exceptions)
    // Wait 3 seconds after component mount to ensure system is ready
    const initialTimeout = setTimeout(() => {
      if (!isCleanedUp) {
        trackUrlActivity();
      }
    }, 3000); // Wait 3 seconds before first call

    return () => {
      isCleanedUp = true;
      clearTimeout(initialTimeout); // Clear initial timeout on cleanup
      
      // Save current URL activity before cleanup
      if (currentUrl !== null && urlStartTime !== null && currentDomain) {
        const { isTracking, isPaused, currentTimeEntry } = useTrackerStore.getState();
        if (isTracking && !isPaused && currentTimeEntry) {
          const timeSpent = Math.floor((Date.now() - urlStartTime) / 1000);
          if (timeSpent >= minUrlTimeSeconds) {
            useTrackerStore.getState().addUrlActivity({
              timeEntryId: currentTimeEntry.id,
              url: currentUrl,
              domain: currentDomain,
              title: currentTitle || currentUrl,
              timeSpent,
            });
          }
        }
      }
      
      if (urlTrackingInterval) {
        clearInterval(urlTrackingInterval);
      }
      if (urlSendInterval) {
        clearInterval(urlSendInterval);
      }
    };
  }, [isAuthenticated]);

  // Setup screenshot interval (random between 1-10 minutes)
  useEffect(() => {
    if (!isAuthenticated) return;

    let isCleanedUp = false;
    let screenshotTimeout: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    
    // Generate random interval in milliseconds (1-10 minutes)
    const getRandomInterval = (): number => {
      const minMinutes = 1;
      const maxMinutes = 10;
      const randomMinutes = Math.random() * (maxMinutes - minMinutes) + minMinutes;
      return Math.floor(randomMinutes * 60 * 1000); // Convert to milliseconds
    };

    const takeScreenshot = async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      
      // Check flag BEFORE async operations to prevent race conditions
      if (isCleanedUp) {
        return;
      }
      
      // Check store flag first to prevent race conditions
      const state = useTrackerStore.getState();
      if (state.isTakingScreenshot) {
        await logger.safeLogToRust(`[SCREENSHOT] Skipped: already taking screenshot (store flag)`).catch((e) => {
          logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
        });
        return; // Prevent multiple simultaneous screenshots
      }
      
      // Set flag in store immediately to prevent race conditions
      useTrackerStore.setState({ isTakingScreenshot: true });
      
      // Only take screenshot if tracking is active, not paused, and not idle
      const currentState = useTrackerStore.getState();
      if (!currentState.isTracking || currentState.isPaused || !currentState.currentTimeEntry || currentState.idlePauseStartTime !== null) {
        await logger.safeLogToRust(`[SCREENSHOT] Skipped: isTracking=${currentState.isTracking}, isPaused=${currentState.isPaused}, hasEntry=${!!currentState.currentTimeEntry}, isIdle=${currentState.idlePauseStartTime !== null}`).catch((e) => {
          logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
        });
        // Reset flag if we're not taking screenshot
        useTrackerStore.setState({ isTakingScreenshot: false });
        return;
      }

      await logger.safeLogToRust('[SCREENSHOT] Starting screenshot capture...').catch((e) => {
        logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
      });
      
      try {
        // Final state check before taking screenshot
        const finalState = useTrackerStore.getState();
        if (!finalState.isTracking || finalState.isPaused || !finalState.currentTimeEntry || finalState.idlePauseStartTime !== null || isCleanedUp) {
          useTrackerStore.setState({ isTakingScreenshot: false });
          return; // State changed or idle, skip screenshot
        }
        
        // Take screenshot via Rust
        const screenshotData = await invoke<number[]>('take_screenshot', {
          timeEntryId: finalState.currentTimeEntry.id,
        });
        
        // Final check before upload
        if (isCleanedUp) return;
        
        // Validate screenshot data
        if (!screenshotData || screenshotData.length === 0) {
          throw new Error('Screenshot data is empty');
        }
        
        // Check if screenshot is too large (e.g., > 10MB)
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (screenshotData.length > maxSize) {
          logger.warn('SCREENSHOT', `Screenshot is too large: ${screenshotData.length} bytes`);
          // Continue anyway, but log warning
        }
        
        // Convert to File and upload to backend
        // Handle potential errors during Blob/File creation
        let blob: Blob;
        let file: File;
        try {
          blob = new Blob([new Uint8Array(screenshotData)], { type: 'image/jpeg' });
          file = new File([blob], `screenshot-${Date.now()}.jpg`, { type: 'image/jpeg' });
        } catch (blobError: any) {
          throw new Error(`Failed to create file from screenshot data: ${blobError.message}`);
        }
        
        // Final check before upload
        if (isCleanedUp) return;
        
        // Try uploading via Rust first (more reliable for large files)
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const accessToken = useTrackerStore.getState().getAccessToken();
          
          if (accessToken) {
            await logger.safeLogToRust('[FRONTEND] Uploading via Rust...').catch((e) => {
              logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
            });
            const refreshToken = localStorage.getItem('refresh_token');
            await invoke('upload_screenshot', {
              pngData: Array.from(screenshotData),
              timeEntryId: finalState.currentTimeEntry.id,
              accessToken: accessToken,
              refreshToken: refreshToken || null,
            });
            await logger.safeLogToRust('[FRONTEND] Upload via Rust successful').catch((e) => {
              logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
            });
            
            // Emit event to refresh screenshots view
            if (!isCleanedUp) {
              window.dispatchEvent(new CustomEvent('screenshot:uploaded'));
            }
            return; // Success, exit
          }
        } catch (rustError: any) {
          logger.warn('SCREENSHOT', 'Rust upload failed, trying JS fallback', rustError);
          await logger.safeLogToRust(`[FRONTEND] Rust upload failed: ${rustError}, trying JS fallback...`).catch((e) => {
            logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
          });
        }
        
        await useTrackerStore.getState().uploadScreenshot(file, finalState.currentTimeEntry.id);
        
        // Emit event to refresh screenshots view
        if (!isCleanedUp) {
          window.dispatchEvent(new CustomEvent('screenshot:uploaded'));
        }
        
        // Don't show notification for every screenshot to avoid spam
        // Notification is only shown on errors
      } catch (error: any) {
        // Show error notification only if not cleaned up
        if (!isCleanedUp) {
          await invoke('show_notification', {
            title: 'Ошибка скриншота',
            body: error.message || 'Не удалось сделать скриншот',
          });
        }
      } finally {
        // Always reset flag in store (not local variable)
        useTrackerStore.setState({ isTakingScreenshot: false });
      }
    };

    const scheduleNextScreenshot = async () => {
      if (isCleanedUp) {
        await logger.safeLogToRust('[SCREENSHOT] Cannot schedule: component cleaned up').catch((e) => {
          logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
        });
        return;
      }
      
      const state = useTrackerStore.getState();
      // Don't schedule screenshots if not tracking, paused, idle, or no time entry
      if (!state.isTracking || state.isPaused || !state.currentTimeEntry || state.idlePauseStartTime !== null) {
        await logger.safeLogToRust(`[SCREENSHOT] Cannot schedule: isTracking=${state.isTracking}, isPaused=${state.isPaused}, hasEntry=${!!state.currentTimeEntry}, isIdle=${state.idlePauseStartTime !== null}`).catch((e) => {
          logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
        });
        return; // Don't schedule if not tracking or idle
      }
      
      // Clear any existing timeout
      if (screenshotTimeout) {
        clearTimeout(screenshotTimeout);
        screenshotTimeout = null;
      }
      
      // Generate random interval (1-10 minutes)
      const interval = getRandomInterval();
      const minutes = Math.floor(interval / 60000);
      const seconds = Math.floor((interval % 60000) / 1000);
      
      // Log next screenshot time (for debugging)
      await logger.safeLogToRust(`[SCREENSHOT] Next screenshot scheduled in ${minutes}m ${seconds}s (${interval}ms)`).catch((e) => {
        logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
      });
      
      screenshotTimeout = setTimeout(async () => {
        if (!isCleanedUp) {
          const state = useTrackerStore.getState();
          if (!state.isTracking || state.isPaused || !state.currentTimeEntry || state.idlePauseStartTime !== null) {
            await logger.safeLogToRust(`[SCREENSHOT] Timeout fired but paused/idle — not taking screenshot, not scheduling next`).catch(() => {});
            screenshotTimeout = null;
            return;
          }
          await logger.safeLogToRust('[SCREENSHOT] Timeout triggered, taking screenshot...').catch((e) => {
            logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
          });
          try {
            await takeScreenshot();
            await logger.safeLogToRust('[SCREENSHOT] Screenshot completed, scheduling next...').catch((e) => {
              logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
            });
            await scheduleNextScreenshot();
          } catch (error: any) {
            logger.error('SCREENSHOT', 'Error taking screenshot, still scheduling next', error);
            await logger.safeLogToRust(`[SCREENSHOT] Error: ${error?.message || error}, still scheduling next...`).catch((e) => {
              logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
            });
            await scheduleNextScreenshot();
          }
        }
      }, interval);
    };

    const checkAndStartScreenshots = async () => {
      const state = useTrackerStore.getState();
      
      // Only start screenshots if tracking, not paused, not idle, and has time entry
      if (state.isTracking && !state.isPaused && state.currentTimeEntry && state.idlePauseStartTime === null) {
        // Start screenshots if not already scheduled
        if (!screenshotTimeout) {
          await logger.safeLogToRust('[SCREENSHOT] Starting screenshot scheduling...').catch((e) => {
            logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
          });
          await scheduleNextScreenshot();
        }
      } else {
        // Stop screenshots if tracking stopped, paused, or idle
        if (screenshotTimeout) {
          const reason = !state.isTracking ? 'tracking stopped' : 
                        state.isPaused ? 'paused' : 
                        state.idlePauseStartTime !== null ? 'idle' : 
                        'no time entry';
          await logger.safeLogToRust(`[SCREENSHOT] Stopping screenshot scheduling: ${reason}`).catch((e) => {
            logger.debug('SCREENSHOT', 'Failed to log (non-critical)', e);
          });
          clearTimeout(screenshotTimeout);
          screenshotTimeout = null;
        }
      }
    };

    // Check initially
    checkAndStartScreenshots().catch((e) => {
      logger.error('SCREENSHOT', 'Initial check failed', e);
    });

    // Subscribe to store changes to react immediately to state changes
    unsubscribe = useTrackerStore.subscribe(() => {
      // When store changes, check if we need to start/stop screenshots
      if (!isCleanedUp) {
        checkAndStartScreenshots().catch((e) => {
          logger.error('SCREENSHOT', 'Store change check failed', e);
        });
      }
    });

    // Check periodically (every 5 seconds) to handle state changes
    // FIX: Увеличено с 2 до 5 секунд - store subscription должно быть достаточным
    const checkInterval = setInterval(() => {
      if (!isCleanedUp) {
        checkAndStartScreenshots().catch((e) => {
          logger.error('SCREENSHOT', 'Interval check failed', e);
        });
      }
    }, 5000); // Check every 5 seconds (было 2 секунды)

    return () => {
      isCleanedUp = true;
      if (screenshotTimeout) {
        clearTimeout(screenshotTimeout);
      }
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [isAuthenticated]);

  // Listen for resume/stop events from idle window
  useEffect(() => {
    if (!isAuthenticated) return;

    const setupIdleWindowListeners = async () => {
      try {
        // Listen for resume event from idle window
        const unlistenResume = await listen('resume-tracking', async () => {
          const { resumeTracking } = useTrackerStore.getState();
          try {
            await resumeTracking();
          } catch (error) {
            logger.error('APP', 'Failed to resume from idle window', error);
            await logger.safeLogToRust(`[APP] Failed to resume from idle window: ${error}`).catch((e) => {
              logger.debug('APP', 'Failed to log (non-critical)', e);
            });
          }
        });

        // Listen for stop event from idle window
        const unlistenStop = await listen('stop-tracking', async () => {
          const { stopTracking } = useTrackerStore.getState();
          try {
            await stopTracking();
          } catch (error) {
            logger.error('APP', 'Failed to stop from idle window', error);
            await logger.safeLogToRust(`[APP] Failed to stop from idle window: ${error}`).catch((e) => {
              logger.debug('APP', 'Failed to log (non-critical)', e);
            });
          }
        });

        return () => {
          unlistenResume();
          unlistenStop();
        };
      } catch (error) {
        logger.error('APP', 'Failed to setup idle window listeners', error);
        await logger.safeLogToRust(`[APP] Failed to setup idle window listeners: ${error}`).catch((e) => {
          logger.debug('APP', 'Failed to log (non-critical)', e);
        });
        return undefined; // Return undefined on error
      }
    };

    let cleanupFn: (() => void) | null = null;
    
    setupIdleWindowListeners().then((cleanup) => {
      if (cleanup) {
        cleanupFn = cleanup;
      }
    }).catch((e) => {
      logger.error('APP', 'Failed to setup idle window listeners (cleanup)', e);
    });
    
    return () => {
      // Synchronous cleanup if available
      if (cleanupFn) {
        cleanupFn();
      }
    };
  }, [isAuthenticated]);

  // Listen for state request from idle window
  useEffect(() => {
    if (!isAuthenticated) return;

    const setupStateRequestListener = async () => {
      try {
        const unlisten = await listen('request-idle-state-for-idle-window', async () => {
          logger.debug('APP', '🔔 Idle window requested current state');
          const state = useTrackerStore.getState();
          const { idlePauseStartTime, isLoading } = state;
          
          logger.debug('APP', '📊 Current state from store', { 
            idlePauseStartTime, 
            isLoading,
            type: typeof idlePauseStartTime,
            isNull: idlePauseStartTime === null,
            isUndefined: idlePauseStartTime === undefined,
            value: idlePauseStartTime
          });
          
          // Send state immediately
          try {
            // FIX: Убеждаемся, что передаем правильное значение
            // Rust Option<u64> принимает null как None
            // В TypeScript при сериализации undefined становится null, но лучше явно передать null
            const pauseTimeForRust = idlePauseStartTime !== null && idlePauseStartTime !== undefined && idlePauseStartTime > 0 
              ? Number(idlePauseStartTime) 
              : null; // Используем null для Rust Option<u64> (None)
            
            logger.debug('APP', '📤 Sending state to idle window (request)', { 
              idlePauseStartTime, 
              pauseTimeForRust,
              type: typeof pauseTimeForRust,
              isUndefined: pauseTimeForRust === undefined,
              isNull: pauseTimeForRust === null
            });
            
            await invoke('update_idle_state', {
              idlePauseStartTime: pauseTimeForRust,
              isLoading: isLoading,
            });
            logger.debug('APP', '✅ State sent to idle window successfully');
          } catch (error) {
            logger.error('APP', '❌ Failed to send state to idle window', error);
          }
        });
        logger.debug('APP', 'State request listener set up');
        return unlisten;
      } catch (error) {
        logger.error('APP', 'Failed to setup state request listener', error);
      }
    };

    let cleanupFn: (() => void) | null = null;
    
    setupStateRequestListener().then((cleanup) => {
      if (cleanup) {
        cleanupFn = cleanup;
      }
    }).catch((e) => {
      logger.error('APP', 'Failed to setup state request listener (cleanup)', e);
    });
    
    return () => {
      // Synchronous cleanup if available
      if (cleanupFn) {
        cleanupFn();
      }
    };
  }, [isAuthenticated]);

  // Send state updates to idle window when it changes
  useEffect(() => {
    if (!isAuthenticated) return;

    const sendStateUpdate = async () => {
      // Get fresh state each time
      const { idlePauseStartTime, isLoading, isTakingScreenshot } = useTrackerStore.getState();
      // Don't block idle window buttons during screenshots
      // Only send isLoading=true if it's actually a loading operation, not a screenshot
      const effectiveIsLoading = isLoading && !isTakingScreenshot;
      logger.debug('APP', 'Sending state update to idle window', { 
        idlePauseStartTime, 
        isLoading, 
        isTakingScreenshot,
        effectiveIsLoading 
      });
      try {
        // FIX: Убеждаемся, что передаем правильное значение
        // Rust Option<u64> принимает null как None
        const pauseTimeForRust = idlePauseStartTime !== null && idlePauseStartTime !== undefined && idlePauseStartTime > 0 
          ? Number(idlePauseStartTime) 
          : null; // Используем null для Rust Option<u64> (None)
        
        logger.debug('APP', 'Sending state to idle window', { 
          idlePauseStartTime, 
          pauseTimeForRust,
          type: typeof pauseTimeForRust 
        });
        
        await invoke('update_idle_state', {
          idlePauseStartTime: pauseTimeForRust,
          isLoading: effectiveIsLoading, // Don't block buttons during screenshots
        });
        logger.debug('APP', 'State update sent successfully');
      } catch (error) {
        logger.error('APP', 'Failed to send state update to idle window', error);
        // Ignore errors - idle window might not be open
      }
    };

    // Initialize previous values from current state
    const initialState = useTrackerStore.getState();
    let prevIdlePauseStartTime: number | null = initialState.idlePauseStartTime;
    let prevIsLoading = initialState.isLoading;
    
    // Send initial state
    sendStateUpdate();

    // Subscribe to store changes - only send updates when relevant fields change
    // IMPORTANT: Don't send isLoading updates when isTakingScreenshot changes
    // Screenshots should not block idle window buttons
    const unsubscribe = useTrackerStore.subscribe((state) => {
      // Only send update if idlePauseStartTime or isLoading changed
      // But ignore isLoading if it's only due to screenshot (isTakingScreenshot)
      const shouldUpdate = 
        state.idlePauseStartTime !== prevIdlePauseStartTime ||
        (state.isLoading !== prevIsLoading && !state.isTakingScreenshot); // Don't block buttons during screenshots
      
      if (shouldUpdate) {
      logger.debug('APP', 'Store changed', {
        oldIdlePauseStartTime: prevIdlePauseStartTime,
          newIdlePauseStartTime: state.idlePauseStartTime,
          oldIsLoading: prevIsLoading,
          newIsLoading: state.isLoading,
          isTakingScreenshot: state.isTakingScreenshot,
        });
        prevIdlePauseStartTime = state.idlePauseStartTime;
        // Only update prevIsLoading if it's not due to screenshot
        if (!state.isTakingScreenshot) {
          prevIsLoading = state.isLoading;
        }
        sendStateUpdate();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <ErrorBoundary>
        <Login />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen bg-background overflow-hidden flex flex-col">
        {updateAvailable && (
          <div className="px-4 py-2 bg-primary text-primary-foreground flex items-center justify-between gap-3 shrink-0">
            <span className="text-sm">
              Доступна новая версия {updateAvailable.version}. {updateAvailable.body ?? ''}
            </span>
            <button
              type="button"
              onClick={installUpdate}
              className="shrink-0 px-3 py-1 rounded bg-primary-foreground text-primary text-sm font-medium hover:opacity-90"
            >
              Установить
            </button>
          </div>
        )}
        <Tabs defaultValue="tracker" className="flex flex-col h-full">
          {/* Header - macOS-style segmented control */}
          <div className="px-6 pt-3 pb-2.5 border-b flex items-center justify-between">
            <TabsList className="w-auto">
              <TabsTrigger value="tracker">Трекер</TabsTrigger>
              {user && (user.role === USER_ROLES.OWNER || user.role === USER_ROLES.ADMIN) && (
                <TabsTrigger value="settings">Настройки</TabsTrigger>
              )}
            </TabsList>
            {user && (
              <Button
                onClick={async () => {
                  // При logout не вызываем reset() - это позволит восстановить таймер при повторном входе
                  // Timer Engine в Rust будет сброшен через set_auth_tokens, но активный time entry на сервере продолжит работать
                  // При login loadActiveTimeEntry() восстановит активный time entry и синхронизирует Timer Engine
                  await logout();
                  // Очищаем только локальное UI состояние, не останавливая таймер на сервере
                  const { useTrackerStore } = await import('./store/useTrackerStore');
                  const store = useTrackerStore.getState();
                  store.set({
                    projects: [],
                    selectedProject: null,
                    currentTimeEntry: null,
                    isTracking: false,
                    isPaused: false,
                    isLoading: false,
                    error: null,
                    idlePauseStartTime: null,
                    urlActivities: [],
                  });
                }}
                variant="ghost"
                size="sm"
                className="gap-2 h-8"
              >
                <LogOut className="h-3.5 w-3.5" />
                Log out
              </Button>
            )}
          </div>
          
          {/* Main Content - Таймер как главный элемент */}
          <TabsContent value="tracker" className="flex-1 overflow-y-auto m-0">
            <div className="max-w-3xl mx-auto px-6 py-8">
              {/* Проект - inline формат, минимальный вес */}
              <div className="mb-6">
                <ProjectSelector />
              </div>
              
              {/* Таймер - главный визуальный якорь */}
              <TimerWithScreenshots />
            </div>
          </TabsContent>
          
          {user && (user.role === USER_ROLES.OWNER || user.role === USER_ROLES.ADMIN) && (
            <TabsContent value="settings" className="flex-1 overflow-y-auto p-4 m-0">
              <Settings />
            </TabsContent>
          )}
          
          {/* Footer - Синхронизация (ненавязчиво) */}
          <div className="px-6 py-3 border-t bg-muted/30">
            <div className="flex items-center justify-end">
              <SyncIndicator />
            </div>
          </div>
        </Tabs>
      </div>
    </ErrorBoundary>
  );
}

export default App;
