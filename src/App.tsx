import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { useTrackerStore } from './store/useTrackerStore';
import type { TimerStateResponse } from './lib/timer-engine';
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
import { api, USER_ROLES } from './lib/api';
import './App.css';

const RELEASES_URL = 'https://github.com/balabiturembekov/hubnity-desktop/releases';

function App() {
  const { isAuthenticated, user, logout } = useAuthStore();
  const { loadActiveTimeEntry, selectedProject, currentTimeEntry } = useTrackerStore();
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body?: string } | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);
  const isInstallingRef = useRef<boolean>(false);
  const autoInstallTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [isCheckingForUpdate, setIsCheckingForUpdate] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<'idle' | 'latest' | 'available' | 'error'>('idle');

  // Восстанавливаем токены в Rust AuthManager — иначе фоновая синхронизация всегда получает "token not set" и Синхронизировано = 0
  const restoreTokens = useCallback(async () => {
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

  // Load app version
  useEffect(() => {
    invoke<string>('get_app_version')
      .then(version => {
        setAppVersion(version);
      })
      .catch(error => {
        logger.debug('APP', 'Failed to get app version', error);
        // Fallback to package.json version if available
        setAppVersion('0.1.23'); // Fallback when get_app_version fails
      });
  }, []);

  // Критично: каждые 30 с передаём токены в Rust (если есть) и запускаем синхронизацию.
  // Не полагаемся на isAuthenticated — токен может быть в localStorage до регидрации Zustand.
  useEffect(() => {
    const pushTokensAndSync = async () => {
      try {
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
        // Create tray menu items
        const menuItems = [
          { id: 'show', text: 'Show' },
          { id: 'hide', text: 'Hide' },
          { id: 'separator', text: '' },
          { id: 'quit', text: 'Quit' },
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
            title: 'Permission check',
            body: 'Could not access screenshots. Make sure the app has the required permissions.',
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

    let syncSkippedDueToLoading = 0;
    const syncTimerState = async () => {
      try {
        const { currentTimeEntry, idlePauseStartTime, isLoading, getTimerState } = useTrackerStore.getState();
        
        // BUG FIX: Don't sync if another operation is in progress
        // This prevents sync from interfering with user actions or other operations
        if (isLoading) {
          syncSkippedDueToLoading++;
          if (syncSkippedDueToLoading >= 6) {
            logger.warn('APP', 'syncTimerState: isLoading stuck for 60s, forcing recovery');
            useTrackerStore.setState({ isLoading: false });
            syncSkippedDueToLoading = 0;
          } else {
            logger.debug('APP', 'Skipping sync: operation in progress');
            return;
          }
        } else {
          syncSkippedDueToLoading = 0;
        }
        
        // BUG FIX: Check actual Timer Engine state instead of store cache
        // Store cache can be stale if updateTimerState was skipped
        let timerState: TimerStateResponse | null = null;
        try {
          timerState = await getTimerState();
        } catch (error) {
          logger.warn('APP', 'Failed to get Timer Engine state for sync', error);
          return; // Can't sync without timer state
        }
        
        const isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
        const isPaused = timerState.state === 'PAUSED';
        
        // Если локально нет активной записи и таймер остановлен, не нужно синхронизировать
        if (!currentTimeEntry && !isTracking) {
          return;
        }
        
        // НЕ синхронизируем автоматически если локально на паузе из-за idle
        // Пользователь должен сам решить возобновлять или останавливать через idle окно
        if (isPaused && idlePauseStartTime !== null) {
          logger.debug('APP', 'Skipping sync: timer paused due to idle, user must decide via idle window');
          return;
        }
        
        const activeEntries = await api.getActiveTimeEntries();
        
        if (activeEntries.length > 0) {
          // BUG FIX: Сортируем по startTime (самая свежая первая), как в loadActiveTimeEntry
          const sortedEntries = [...activeEntries].sort((a, b) =>
            new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          );
          const activeEntry = sortedEntries[0];
          if (!activeEntry) return;
          const { currentTimeEntry: currentEntry, loadActiveTimeEntry } = useTrackerStore.getState();
          
          // Если нет currentTimeEntry, но таймер работает — пробуем загрузить с сервера
          if (!currentEntry) {
            if (isTracking) {
              await loadActiveTimeEntry().catch((e) => logger.warn('APP', 'loadActiveTimeEntry failed during sync', e));
            }
            return;
          }
          
          // BUG FIX: Проверяем соответствие ID — при расхождении (мультиустройство или temp vs server)
          // загружаем состояние с сервера вместо применения действий к неверной записи
          if (currentEntry.id !== activeEntry.id) {
            logger.debug('APP', `Sync: currentEntry.id (${currentEntry.id}) !== activeEntry.id (${activeEntry.id}), loading from server`);
            await loadActiveTimeEntry().catch((e) => logger.warn('APP', 'loadActiveTimeEntry failed during sync', e));
            return;
          }
          
          // timerState already fetched above
          
          // Синхронизируем состояние таймера с сервером
          if (activeEntry.status === 'RUNNING' && timerState.state !== 'RUNNING') {
            // На сервере RUNNING, но локально не RUNNING - запускаем
            // BUG FIX: Check if timer is paused before resuming (resumeTracking requires isPaused=true)
            const currentStoreState = useTrackerStore.getState();
            if (currentStoreState.isPaused || timerState.state === 'PAUSED') {
              logger.info('APP', 'Syncing timer: server is RUNNING, resuming local timer');
              const { resumeTracking } = useTrackerStore.getState();
              await resumeTracking(undefined, true).catch((e) => {
                logger.warn('APP', 'Failed to resume timer on sync', e);
              });
            } else if (timerState.state === 'STOPPED') {
              // Timer is stopped, need to start instead of resume
              logger.info('APP', 'Syncing timer: server is RUNNING, starting local timer');
              const { startTracking } = useTrackerStore.getState();
              await startTracking(undefined, true).catch((e) => {
                logger.warn('APP', 'Failed to start timer on sync', e);
              });
            }
          } else if (activeEntry.status === 'PAUSED' && timerState.state === 'RUNNING') {
            // На сервере PAUSED, но локально RUNNING - ставим на паузу
            // Но не паузим если локально на паузе из-за idle (пользователь должен решить через idle окно)
            // BUG FIX: Use actual timerState.isPaused instead of store cache
            // BUG FIX: Also check if idle window might be open (idlePauseStartTime was recently cleared)
            // If idlePauseStartTime was cleared recently (< 5 seconds ago), user might have just resumed from idle window
            const storeState = useTrackerStore.getState();
            if (isPaused && idlePauseStartTime !== null) {
              logger.debug('APP', 'Skipping sync pause: timer paused due to idle, user must decide via idle window');
              return;
            }
            // BUG FIX: Additional check - if idle window was recently closed (idlePauseStartTime cleared < 5s ago),
            // don't auto-pause - user might have just resumed from idle window
            // This prevents race condition where syncTimerState tries to pause right after resume from idle window
            if (storeState.lastResumeTime && storeState.idlePauseStartTime === null) {
              const FIVE_SECONDS = 5 * 1000;
              const timeSinceResume = Date.now() - storeState.lastResumeTime;
              if (timeSinceResume < FIVE_SECONDS) {
                const secondsSinceResume = Math.round(timeSinceResume / 1000);
                logger.info('APP', `Skipping sync pause: idle window was recently closed (${secondsSinceResume}s ago), user might have just resumed`);
                return;
              }
            }
            
            // BUG FIX: Don't auto-pause if resume was just called (< 15 seconds ago)
            // This prevents sync from pausing timer immediately after user resumes it
            // Server may not have updated yet, causing false sync pause
            // Increased to 15 seconds to cover at least one sync cycle (10s interval)
            const FIFTEEN_SECONDS = 15 * 1000; // 15 seconds in milliseconds
            if (storeState.lastResumeTime && (Date.now() - storeState.lastResumeTime) < FIFTEEN_SECONDS) {
              const timeSinceResume = Math.round((Date.now() - storeState.lastResumeTime) / 1000);
              logger.info('APP', `Skipping sync pause: timer was just resumed (${timeSinceResume}s ago), server may not have updated yet`);
              return;
            }
            
            // BUG FIX: Also check if there are pending resume operations in sync queue
            // If there's a pending resume, don't auto-pause - wait for it to sync first
            try {
              const syncStatus = await invoke<{ pending_count: number; failed_count: number; is_online: boolean }>('get_sync_status');
              if (syncStatus.pending_count > 0) {
                // Check if there are any resume operations pending
                const queueStats = await invoke<{ pending_by_type: Record<string, number> }>('get_sync_queue_stats').catch(() => null);
                if (queueStats?.pending_by_type?.['time_entry_resume'] && queueStats.pending_by_type['time_entry_resume'] > 0) {
                  logger.info('APP', `Skipping sync pause: ${queueStats.pending_by_type['time_entry_resume']} pending resume operation(s) in queue, waiting for sync`);
                  return;
                }
              }
            } catch (e) {
              // If we can't check queue status, continue with pause (better to sync than to ignore)
              logger.debug('APP', 'Failed to check sync queue status, proceeding with pause', e);
            }
            
            // BUG FIX: Additional check - don't auto-pause if Timer Engine was just started/resumed locally
            // Check if timer was started/resumed recently (within last 30 seconds)
            // This protects against auto-pause when user just resumed timer but server hasn't updated yet
            if (storeState.localTimerStartTime) {
              const THIRTY_SECONDS = 30 * 1000; // 30 seconds in milliseconds
              const timeSinceStart = Date.now() - storeState.localTimerStartTime;
              if (timeSinceStart < THIRTY_SECONDS) {
                const secondsSinceStart = Math.round(timeSinceStart / 1000);
                logger.info('APP', `Skipping sync pause: timer was started/resumed locally recently (${secondsSinceStart}s ago), server may not have updated yet`);
                return;
              }
            }
            
            logger.info('APP', 'Syncing timer: server is PAUSED, pausing local timer (auto-sync)');
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
          // Нет активных записей на сервере — проверяем, нужно ли останавливать таймер
          const { currentTimeEntry: currentEntry, getTimerState, clearTrackingStateFromServer, localTimerStartTime } = useTrackerStore.getState();
          if (!currentEntry) {
            return; // Уже остановлено локально
          }
          
          // BUG FIX: Don't auto-stop timer if it was started locally recently (< 2 minutes ago)
          // This protects against stopping timer when API call failed but Timer Engine is running
          const TWO_MINUTES = 2 * 60 * 1000; // 2 minutes in milliseconds
          if (localTimerStartTime && (Date.now() - localTimerStartTime) < TWO_MINUTES) {
            logger.debug('APP', 'Syncing timer: timer started locally recently, skipping auto-stop (API may still be syncing)');
            return; // Don't stop timer if it was started locally recently
          }
          
          const timerState = await getTimerState();
          if (timerState.state !== 'STOPPED') {
            // BUG FIX: Don't auto-stop timer if it's PAUSED after system wake (restored_from_running)
            // User should be able to resume manually; only skip when we know it's wake-restore
            if (timerState.state === 'PAUSED' && timerState.restored_from_running) {
              logger.info('APP', 'Syncing timer: timer is PAUSED after wake (restored_from_running), allowing user to resume manually');
              return;
            }
            
            logger.info('APP', 'Syncing timer: no active entries on server, stopping local timer');
            const { stopTracking } = useTrackerStore.getState();
            await stopTracking().catch((e) => {
              logger.warn('APP', 'Failed to stop timer on sync', e);
            });
          } else {
            // Rust уже STOPPED, но в сторе ещё есть currentTimeEntry — очищаем стор
            logger.info('APP', 'Syncing timer: no active entries on server, clearing store');
            await clearTrackingStateFromServer();
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

  // Периодическая проверка инвариантов состояния (каждые 5 секунд)
  // Автоматически обнаруживает и исправляет рассинхронизацию между Timer Engine и Store
  useEffect(() => {
    if (!isAuthenticated) return;

    const checkStateInvariant = async () => {
      try {
        const { assertStateInvariant } = useTrackerStore.getState();
        await assertStateInvariant();
      } catch (error) {
        logger.debug('APP', 'Failed to check state invariant (non-critical)', error);
      }
    };

    // Первая проверка через 5 секунд после загрузки
    const initialTimeout = setTimeout(checkStateInvariant, 5000);
    // Затем каждые 5 секунд
    const interval = setInterval(checkStateInvariant, 5000);

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

  // Проверка обновлений: первая проверка через 15 с, затем каждые 30 мин
  // Раньше проверяли только раз — пользователи с открытым приложением не видели новые релизы
  useEffect(() => {
    let cancelled = false;
    const checkForUpdate = async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (cancelled || !update) return;
        pendingUpdateRef.current = update;
        setUpdateAvailable({ version: update.version, body: update.body ?? undefined });
        logger.info('APP', `Update available: ${update.version}`);
        
        await invoke('show_notification', {
          title: 'Hubnity',
          body: `New version ${update.version} available. Installation will start automatically...`,
        }).catch(() => {});
        
        autoInstallTimeoutRef.current = setTimeout(async () => {
          if (cancelled) return;
          if (isInstallingRef.current) return;
          isInstallingRef.current = true;
          
          try {
            logger.info('APP', `Starting automatic update installation for version ${update.version}`);
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await update.downloadAndInstall();
            logger.info('APP', 'Update installed successfully, relaunching...');
            await relaunch();
          } catch (e: any) {
            isInstallingRef.current = false;
            const err = e instanceof Error ? e : new Error(String(e));
            logger.error('APP', `Automatic update install failed: ${err.message}`, err);
            await logger.safeLogToRust(`[UPDATE] Auto-install failed: ${err.message}`).catch(() => {});
            await invoke('show_notification', {
              title: 'Hubnity',
              body: `Could not install update automatically. Try "Install update" button or download from the website.`,
            }).catch(() => {});
            try {
              const { openUrl } = await import('@tauri-apps/plugin-opener');
              await openUrl(RELEASES_URL);
            } catch {
              // ignore
            }
          }
        }, 5000); // 5 секунд — пользователь успевает увидеть уведомление
      } catch (e: any) {
        if (e?.message?.includes('update endpoint') || e?.message?.includes('status code')) {
          logger.debug('APP', 'Update endpoint unavailable (non-critical)', e);
        } else {
          logger.debug('APP', 'Update check failed (non-critical)', e);
        }
      }
    };

    const initialTimeout = setTimeout(checkForUpdate, 15000);
    const interval = setInterval(checkForUpdate, 30 * 60 * 1000); // каждые 30 мин

    return () => {
      cancelled = true;
      clearTimeout(initialTimeout);
      clearInterval(interval);
      if (autoInstallTimeoutRef.current) {
        clearTimeout(autoInstallTimeoutRef.current);
      }
    };
  }, []);

  const isCheckingUpdateRef = useRef(false);
  const checkForUpdateManually = useCallback(async () => {
    if (isCheckingUpdateRef.current) return;
    isCheckingUpdateRef.current = true;
    setIsCheckingForUpdate(true);
    setUpdateCheckResult('idle');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setUpdateCheckResult('latest');
        await invoke('show_notification', {
          title: 'Hubnity',
          body: 'You are on the latest version.',
        }).catch(() => {});
        return;
      }
      pendingUpdateRef.current = update;
      setUpdateAvailable({ version: update.version, body: update.body ?? undefined });
      setUpdateCheckResult('available');
      await invoke('show_notification', {
        title: 'Hubnity',
        body: `New version ${update.version} available.`,
      }).catch(() => {});
    } catch (e) {
      logger.debug('APP', 'Update check failed', e);
      await logger.safeLogToRust(`[UPDATE] Check failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
      setUpdateCheckResult('error');
      await invoke('show_notification', {
        title: 'Hubnity',
        body: 'Could not check for updates. Check your internet connection.',
      }).catch(() => {});
    } finally {
      isCheckingUpdateRef.current = false;
      setIsCheckingForUpdate(false);
      // Clear inline result after 5s so footer stays clean
      setTimeout(() => setUpdateCheckResult('idle'), 5000);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    // Атомарная проверка и установка флага для предотвращения race condition
    if (isInstallingRef.current) {
      logger.debug('APP', 'Update installation already in progress, skipping');
      return;
    }
    isInstallingRef.current = true;
    
    const update = pendingUpdateRef.current;
    if (!update) {
      isInstallingRef.current = false;
      return;
    }
    
    // Отменяем автоматическую установку, если пользователь нажал кнопку вручную
    if (autoInstallTimeoutRef.current) {
      clearTimeout(autoInstallTimeoutRef.current);
      autoInstallTimeoutRef.current = null;
    }
    
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await update.downloadAndInstall();
      logger.info('APP', 'Update installed successfully, relaunching...');
      await relaunch();
    } catch (e) {
      isInstallingRef.current = false;
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error('APP', `Update install failed: ${err.message}`, err);
      await invoke('show_notification', {
        title: 'Hubnity',
        body: 'Could not install update. Try downloading from the website.',
      }).catch(() => {});
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(RELEASES_URL);
      } catch {
        // ignore
      }
    }
  }, []);

  const openReleasesPage = useCallback(async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(RELEASES_URL);
    } catch (e) {
      logger.error('APP', 'Failed to open releases page', e);
    }
  }, []);

  // Setup activity monitoring listeners and heartbeat
  useEffect(() => {
    if (!isAuthenticated) return;

    let isCleanedUp = false;
    const unlistenRef = { current: null as (() => void) | null };

    // FIX: DOM fallback for lastActivityTime — macOS HIDIdleTime can fail to reset on keyboard-only
    // (Karabiner-Elements issue #385). Detect mousemove/keydown/etc in app window.
    const DOM_THROTTLE_MS = 5000;
    let lastDomUpdate = 0;
    const onDomActivity = () => {
      if (isCleanedUp) return;
      const now = Date.now();
      if (now - lastDomUpdate >= DOM_THROTTLE_MS) {
        lastDomUpdate = now;
        useTrackerStore.getState().updateActivityTime();
      }
    };
    const domEvents = ['mousemove', 'keydown', 'mousedown', 'click', 'touchstart', 'scroll'] as const;
    for (const ev of domEvents) {
      window.addEventListener(ev, onDomActivity);
    }

    // FIX: Create intervals synchronously so cleanup can clear them (prevents leak on unmount before async)
    const idleCheckInterval = setInterval(() => {
      if (!isCleanedUp) {
        useTrackerStore.getState().checkIdleStatus();
      }
    }, 10000);

    const heartbeatInterval = setInterval(async () => {
      if (!isCleanedUp) {
        try {
          const store = useTrackerStore.getState();
          const { lastActivityTime } = store;
          const now = Date.now();
          const timeSinceActivity = (now - lastActivityTime) / 1000;
          const isActive = timeSinceActivity < 60;
          await store.sendHeartbeat(isActive);
        } catch (error) {
          logger.error('APP', 'Failed to send idle heartbeat', error);
        }
      }
    }, 45000);

    (async () => {
      try {
        const unlisten = await listen<number>('activity-detected', (ev) => {
          if (isCleanedUp) return;
          logger.safeLogToRust('[ACTIVITY] Event received from Rust').catch((e) => {
            logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
          });
          useTrackerStore.getState().updateActivityTime(ev.payload);
        });
        unlistenRef.current = unlisten;
        if (isCleanedUp) unlisten();
        await logger.safeLogToRust('[ACTIVITY] Activity listener set up successfully').catch(() => {});
      } catch (error) {
        logger.error('ACTIVITY', 'Failed to setup activity listener', error);
      }
    })();

    return () => {
      isCleanedUp = true;
      for (const ev of domEvents) {
        window.removeEventListener(ev, onDomActivity);
      }
      clearInterval(idleCheckInterval);
      clearInterval(heartbeatInterval);
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [isAuthenticated]);

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
      
      let screenshotData: number[] | null = null;
      let finalState = useTrackerStore.getState();
      
      try {
        // Final state check before taking screenshot
        finalState = useTrackerStore.getState();
        if (!finalState.isTracking || finalState.isPaused || !finalState.currentTimeEntry || finalState.idlePauseStartTime !== null || isCleanedUp) {
          useTrackerStore.setState({ isTakingScreenshot: false });
          return; // State changed or idle, skip screenshot
        }
        
        // Take screenshot via Rust
        screenshotData = await invoke<number[]>('take_screenshot', {
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
        // FIX: Last resort — try to enqueue via Rust so screenshot syncs when online
        // Both Rust and JS upload failed; enqueue preserves the screenshot for retry
        if (!isCleanedUp) {
          try {
            const accessToken = useTrackerStore.getState().getAccessToken();
            const refreshToken = localStorage.getItem('refresh_token');
            if (accessToken && screenshotData && screenshotData.length > 0 && finalState.currentTimeEntry) {
              await invoke('upload_screenshot', {
                pngData: Array.from(screenshotData),
                timeEntryId: finalState.currentTimeEntry.id,
                accessToken,
                refreshToken: refreshToken || null,
              });
              await invoke('show_notification', {
                title: 'Screenshot queued',
                body: 'Will sync when connection is restored',
              });
              window.dispatchEvent(new CustomEvent('screenshot:uploaded'));
              return;
            }
          } catch (enqueueErr: any) {
            logger.warn('SCREENSHOT', 'Enqueue fallback failed', enqueueErr);
          }
          await invoke('show_notification', {
            title: 'Screenshot error',
            body: error.message || 'Could not take screenshot',
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
  // CRITICAL FIX: useRef must be called unconditionally, before any early returns
  const idleWindowCleanupRef = useRef<(() => void) | null>(null);
  const idleWindowMountedRef = useRef(true);
  
  useEffect(() => {
    if (!isAuthenticated) {
      idleWindowMountedRef.current = false;
      return;
    }
    
    // Reset mounted state when authenticated
    idleWindowMountedRef.current = true;

    const setupIdleWindowListeners = async () => {
      try {
        // Listen for resume event from idle window
        const unlistenResume = await listen('resume-tracking', async () => {
          // FIX: Update lastActivityTime immediately — prevents checkIdleStatus from re-pausing during async resume (Windows)
          useTrackerStore.getState().updateActivityTime();
          const { resumeTracking } = useTrackerStore.getState();
          try {
            // Pass fromIdleWindow=true to allow resume even if paused due to idle
            await resumeTracking(true);
          } catch (error) {
            logger.error('APP', 'Failed to resume from idle window', error);
            await logger.safeLogToRust(`[APP] Failed to resume from idle window: ${error}`).catch((e) => {
              logger.debug('APP', 'Failed to log (non-critical)', e);
            });
          }
        });

        // Listen for stop event from idle window
        const unlistenStop = await listen('stop-tracking', async () => {
          // FIX: Update lastActivityTime immediately — prevents checkIdleStatus from re-pausing during async stop (Windows)
          useTrackerStore.getState().updateActivityTime();
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

    setupIdleWindowListeners().then((cleanup) => {
      if (!cleanup) return;
      // FIX: If unmounted while listeners were pending, clean up immediately to avoid leak
      if (!idleWindowMountedRef.current) {
        cleanup();
        return;
      }
      idleWindowCleanupRef.current = cleanup;
    }).catch((e) => {
      logger.error('APP', 'Failed to setup idle window listeners (cleanup)', e);
    });
    
    return () => {
      idleWindowMountedRef.current = false;
      // Synchronous cleanup if available
      if (idleWindowCleanupRef.current) {
        idleWindowCleanupRef.current();
        idleWindowCleanupRef.current = null;
      }
    };
  }, [isAuthenticated]);

  // Listen for state request from idle window
  // CRITICAL FIX: useRef must be called unconditionally, before any early returns
  const stateRequestCleanupRef = useRef<(() => void) | null>(null);
  const stateRequestMountedRef = useRef(true);
  
  useEffect(() => {
    if (!isAuthenticated) {
      stateRequestMountedRef.current = false;
      return;
    }
    
    // Reset mounted state when authenticated
    stateRequestMountedRef.current = true;

    const setupStateRequestListener = async () => {
      try {
        const unlisten = await listen('request-idle-state-for-idle-window', async () => {
          logger.debug('APP', '🔔 Idle window requested current state');
          const state = useTrackerStore.getState();
          const { idlePauseStartTime, isLoading, lastActivityTime, selectedProject, currentTimeEntry } = state;
          
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
            
            const lastActivityForRust = lastActivityTime && lastActivityTime > 0 ? Number(lastActivityTime) : null;
            const projectName = selectedProject?.name || currentTimeEntry?.project?.name || null;
            await invoke('update_idle_state', {
              idlePauseStartTime: pauseTimeForRust,
              isLoading: isLoading,
              lastActivityTime: lastActivityForRust,
              projectName,
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

    setupStateRequestListener().then((cleanup) => {
      if (!cleanup) return;
      // FIX: If unmounted while listener was pending, clean up immediately to avoid leak
      if (!stateRequestMountedRef.current) {
        cleanup();
        return;
      }
      stateRequestCleanupRef.current = cleanup;
    }).catch((e) => {
      logger.error('APP', 'Failed to setup state request listener (cleanup)', e);
    });
    
    return () => {
      stateRequestMountedRef.current = false;
      // Synchronous cleanup if available
      if (stateRequestCleanupRef.current) {
        stateRequestCleanupRef.current();
        stateRequestCleanupRef.current = null;
      }
    };
  }, [isAuthenticated]);

  // BUG FIX: Use refs to store previous values so they persist across re-renders
  // This ensures the subscribe callback always has access to the latest previous values
  const prevIdlePauseStartTimeRef = useRef<number | null>(null);
  const prevIsLoadingRef = useRef<boolean>(false);
  
  // BUG FIX: Use useCallback to ensure stable function reference for subscribe callback
  // This prevents stale closures where subscribe callback uses old version of sendStateUpdate
  const sendStateUpdate = useCallback(async () => {
    // Get fresh state each time
    const { idlePauseStartTime, isLoading, isTakingScreenshot, lastActivityTime, selectedProject, currentTimeEntry } = useTrackerStore.getState();
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
      
      const lastActivityForRust = lastActivityTime && lastActivityTime > 0 ? Number(lastActivityTime) : null;
      const projectName = selectedProject?.name || currentTimeEntry?.project?.name || null;
      await invoke('update_idle_state', {
        idlePauseStartTime: pauseTimeForRust,
        isLoading: effectiveIsLoading, // Don't block buttons during screenshots
        lastActivityTime: lastActivityForRust,
        projectName,
      });
      logger.debug('APP', 'State update sent successfully');
    } catch (error) {
      logger.error('APP', 'Failed to send state update to idle window', error);
      // Ignore errors - idle window might not be open
    }
  }, []);

  // Send state updates to idle window when it changes
  useEffect(() => {
    if (!isAuthenticated) return;
    
    // Initialize previous values from current state
    const initialState = useTrackerStore.getState();
    prevIdlePauseStartTimeRef.current = initialState.idlePauseStartTime;
    prevIsLoadingRef.current = initialState.isLoading;
    
    // Send initial state
    sendStateUpdate();

    // Subscribe to store changes - only send updates when relevant fields change
    // IMPORTANT: Don't send isLoading updates when isTakingScreenshot changes
    // Screenshots should not block idle window buttons
    const unsubscribe = useTrackerStore.subscribe((state) => {
      // Only send update if idlePauseStartTime or isLoading changed
      // But ignore isLoading if it's only due to screenshot (isTakingScreenshot)
      const shouldUpdate = 
        state.idlePauseStartTime !== prevIdlePauseStartTimeRef.current ||
        (state.isLoading !== prevIsLoadingRef.current && !state.isTakingScreenshot); // Don't block buttons during screenshots
      
      if (shouldUpdate) {
      logger.debug('APP', 'Store changed', {
        oldIdlePauseStartTime: prevIdlePauseStartTimeRef.current,
          newIdlePauseStartTime: state.idlePauseStartTime,
          oldIsLoading: prevIsLoadingRef.current,
          newIsLoading: state.isLoading,
          isTakingScreenshot: state.isTakingScreenshot,
        });
        prevIdlePauseStartTimeRef.current = state.idlePauseStartTime;
        // Only update prevIsLoading if it's not due to screenshot
        if (!state.isTakingScreenshot) {
          prevIsLoadingRef.current = state.isLoading;
        }
        sendStateUpdate();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isAuthenticated, sendStateUpdate]);

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
              New version {updateAvailable.version} available. Installation will start automatically in a few seconds... {updateAvailable.body ?? ''}
            </span>
            <div className="shrink-0 flex items-center gap-2">
              <button
                type="button"
                onClick={openReleasesPage}
                className="px-3 py-1 rounded bg-primary-foreground/80 text-primary text-sm font-medium hover:bg-primary-foreground"
              >
                Download manually
              </button>
              <button
                type="button"
                onClick={installUpdate}
                className="px-3 py-1 rounded bg-primary-foreground text-primary text-sm font-medium hover:opacity-90"
              >
                Install now
              </button>
            </div>
          </div>
        )}
        <Tabs defaultValue="tracker" className="flex flex-col h-full">
          {/* Header - macOS-style segmented control */}
          <div className="px-6 pt-3 pb-2.5 border-b flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <TabsList className="w-auto flex-shrink-0">
                <TabsTrigger value="tracker">Tracker</TabsTrigger>
                {user && (user.role === USER_ROLES.OWNER || user.role === USER_ROLES.ADMIN) && (
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                )}
              </TabsList>
              {(selectedProject || currentTimeEntry?.project) && (
                <div
                  className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 rounded-md text-xs font-medium truncate max-w-[140px]"
                  style={{
                    backgroundColor: (selectedProject?.color || currentTimeEntry?.project?.color || '#6366f1') + '20',
                    color: selectedProject?.color || currentTimeEntry?.project?.color || '#6366f1',
                  }}
                >
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: selectedProject?.color || currentTimeEntry?.project?.color || '#6366f1',
                    }}
                  />
                  <span className="truncate">
                    {selectedProject?.name || currentTimeEntry?.project?.name || 'Project'}
                  </span>
                </div>
              )}
            </div>
            {user && (
              <Button
                onClick={async () => {
                  // При logout не вызываем reset() - это позволит восстановить таймер при повторном входе
                  // Timer Engine в Rust будет сброшен через set_auth_tokens, но активный time entry на сервере продолжит работать
                  // При login loadActiveTimeEntry() восстановит активный time entry и синхронизирует Timer Engine
                  await logout();
                  // Очищаем только локальное UI состояние, не останавливая таймер на сервере
                  // BUG FIX: Also reset lastActivityTime to prevent stale idle detection on next login
                  useTrackerStore.setState({
                    projects: [],
                    selectedProject: null,
                    currentTimeEntry: null,
                    isTracking: false,
                    isPaused: false,
                    isLoading: false,
                    error: null,
                    idlePauseStartTime: null,
                    lastResumeTime: null,
                    localTimerStartTime: null,
                    lastActivityTime: Date.now(), // Reset to current time to prevent stale idle detection
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
            <div className="max-w-3xl mx-auto px-4 py-4">
              {/* Проект - inline формат, минимальный вес */}
              <div className="mb-4">
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
          
          {/* Footer - Синхронизация и версия (ненавязчиво) */}
          <div className="px-4 py-2 border-t bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {appVersion && (
                  <span className="text-xs text-muted-foreground/60">
                    v{appVersion}
                  </span>
                )}
                <button
                  type="button"
                  onClick={checkForUpdateManually}
                  disabled={isCheckingForUpdate}
                  className="text-xs text-muted-foreground/60 hover:text-foreground/80 underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
                >
                  {isCheckingForUpdate ? 'Checking...' : 'Check for updates'}
                </button>
                {updateCheckResult === 'latest' && (
                  <span className="text-xs text-muted-foreground/50">Up to date</span>
                )}
                {updateCheckResult === 'available' && updateAvailable && (
                  <span className="text-xs text-primary/80">v{updateAvailable.version} available</span>
                )}
                {updateCheckResult === 'error' && (
                  <span className="text-xs text-destructive/80">Check failed</span>
                )}
              </div>
              <SyncIndicator />
            </div>
          </div>
        </Tabs>
      </div>
    </ErrorBoundary>
  );
}

export default App;
