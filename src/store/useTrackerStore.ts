import { create } from 'zustand';
import { api, Project, TimeEntry, UrlActivity } from '../lib/api';
import type { Screenshot } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentUser } from '../lib/current-user';
import { useAuthStore } from './useAuthStore';
import { TimerEngineAPI, type TimerStateResponse } from '../lib/timer-engine';
import { logger } from '../lib/logger';

// Prevents concurrent checkIdleStatus pause flows (multiple intervals / React Strict Mode)
let isIdleCheckPausing = false;

// Coalesces concurrent loadActiveTimeEntry calls — один запрос вместо нескольких
let loadActiveTimeEntryPromise: Promise<void> | null = null;

// BUG FIX: Tracks consecutive skips of assertStateInvariant due to isLoading — prevents permanent block if isLoading gets stuck
let assertStateInvariantSkippedDueToLoading = 0;
const ASSERT_STATE_INVARIANT_LOADING_STUCK_THRESHOLD = 12; // 12 * 5s = 60s

/** CHAOS AUDIT: Surface enqueue errors to user (disk full, permission denied). */
function handleEnqueueError(
  op: string,
  e: unknown,
  set: (s: { error: string | null }) => void,
): null {
  const msg =
    (e as { message?: string })?.message ??
    (e as Error)?.toString?.() ??
    'Data sync unavailable (Disk Full?)';
  logger.warn(op, 'Failed to enqueue - sync queue unavailable', e);
  set({ error: msg });
  invoke('show_notification', { title: 'Sync Warning', body: msg }).catch(() => {});
  return null;
}

export interface TrackerState {
  projects: Project[];
  selectedProject: Project | null;
  currentTimeEntry: TimeEntry | null;
  isTracking: boolean; // UI cache - источник истины в Rust Timer Engine
  isPaused: boolean; // UI cache - источник истины в Rust Timer Engine
  lastActivityTime: number;
  /** performance.now() при последнем обновлении lastActivityTime — для монотонного elapsed (не прыгает при NTP) */
  lastActivityPerfRef: number;
  idleThreshold: number; // in minutes, default 2
  isLoading: boolean;
  /** Lock: true while loadActiveTimeEntry is running — prevents checkIdleStatus/auto-pause from racing */
  isInitializingEntry: boolean;
  error: string | null;
  isTakingScreenshot: boolean; // Indicates if screenshot is being taken
  idlePauseStartTime: number | null; // Timestamp when paused due to inactivity
  /** performance.now() при установке idlePauseStartTime — для монотонного idle display */
  idlePauseStartPerfRef: number | null;
  urlActivities: UrlActivity[]; // Accumulated URL activities waiting to be sent
  localTimerStartTime: number | null; // Timestamp when timer was started locally (for sync protection)
  lastResumeTime: number | null; // Timestamp when timer was last resumed (for sync protection)
  /** Состояние таймера от Rust после start/resume — единая точка отсчёта session_start */
  lastTimerStateFromStart: TimerStateResponse | null;
  /** Момент клика Start/Resume (ms) — точнее Rust as_secs(), устраняет рассинхрон */
  clientSessionStartMs: number | null;
  /** Window visible (not hidden/minimized) — for throttling polls when in tray */
  isWindowVisible: boolean;

  // Actions
  loadProjects: () => Promise<void>;
  loadActiveTimeEntry: () => Promise<void>;
  selectProject: (project: Project) => Promise<void>;
  startTracking: (description?: string, fromSync?: boolean) => Promise<void>;
  pauseTracking: (isIdlePause?: boolean) => Promise<void>;
  resumeTracking: (fromIdleWindow?: boolean, fromSync?: boolean) => Promise<void>;
  stopTracking: () => Promise<void>;
  updateActivityTime: (idleSecs?: number) => void;
  setIdleThreshold: (minutes: number) => void;
  checkIdleStatus: () => Promise<void>;
  addUrlActivity: (activity: UrlActivity) => void;
  sendUrlActivities: () => Promise<void>;
  reset: () => Promise<void>;
  saveTimerState: () => Promise<void>;
  getTimerState: () => Promise<TimerStateResponse>;
  sendHeartbeat: (active: boolean) => Promise<void>;
  uploadScreenshot: (file: File, timeEntryId: string) => Promise<void>;
  getAccessToken: () => string | null;
  getScreenshots: (timeEntryId: string) => Promise<Screenshot[]>;
  resetDay: () => Promise<TimerStateResponse>;
  /** Сбрасывает трекинг в сторе и Rust, когда на сервере нет активных записей (синхронизация). */
  clearTrackingStateFromServer: () => Promise<void>;
  /** Проверяет инварианты состояния и автоматически синхронизирует при рассинхронизации. */
  assertStateInvariant: () => Promise<void>;
  setWindowVisibility: (visible: boolean) => void;
}

export const useTrackerStore = create<TrackerState>((set, get) => ({
  projects: [],
  selectedProject: null,
  currentTimeEntry: null,
  isTracking: false, // UI cache - синхронизируется с Rust Timer Engine
  isPaused: false, // UI cache - синхронизируется с Rust Timer Engine
  lastActivityTime: Date.now(),
  lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  idleThreshold: 2,
  isLoading: false,
  isInitializingEntry: false,
  error: null,
  isTakingScreenshot: false,
  idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
  urlActivities: [], // Accumulated URL activities
  localTimerStartTime: null, // Track when timer was started locally
  lastResumeTime: null, // Track when timer was last resumed (for sync protection)
  lastTimerStateFromStart: null,
  clientSessionStartMs: null,
  isWindowVisible: true,

  setWindowVisibility: (visible: boolean) => set({ isWindowVisible: visible }),

  loadProjects: async () => {
    try {
      set({ isLoading: true, error: null });
      const projects = await api.getProjects();
      set({ projects, isLoading: false });
    } catch (error: any) {
      set({ error: error.message || 'Failed to load projects', isLoading: false });
    }
  },

  loadActiveTimeEntry: async () => {
    if (loadActiveTimeEntryPromise) return loadActiveTimeEntryPromise;
    loadActiveTimeEntryPromise = (async () => {
    set({ isInitializingEntry: true });
    try {
      // SECURITY: Get current user first to verify ownership
      // FIX: Fallback to useAuthStore.user — getCurrentUser() can be null on app reload
      // because it's set asynchronously in restoreTokens, which runs in parallel with loadActiveTimeEntry
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
      logger.debugTerminal('LOAD', `start currentUser=${currentUser?.id ?? 'null'}`);
      if (!currentUser) {
        logger.warn('LOAD', 'Cannot load active time entry: no current user');
        return;
      }

      // FIX: Загружаем проекты перед восстановлением active entry, чтобы можно было найти проект по projectId
      const { projects: currentProjects } = get();
      if (currentProjects.length === 0) {
        try {
          const projects = await api.getProjects();
          set({ projects });
        } catch (e) {
          logger.warn('LOAD', 'Failed to load projects before restoring active entry', e);
        }
      }
      
      const activeEntries = await api.getActiveTimeEntries();
      logger.debugTerminal('LOAD', `getActiveTimeEntries: ${activeEntries.length} items, userIds=${activeEntries.map((e) => e.userId).join(', ')}`);
      if (activeEntries.length === 0) {
        // BUG FIX: Don't auto-stop timer if it's PAUSED or RUNNING without server entry
        // PAUSED: after system wake, user can resume manually
        // RUNNING: user just resumed (e.g. after wake), loadActiveTimeEntry was called from resumeTracking - clearing would stop the timer
        try {
          const timerState = await TimerEngineAPI.getState();
          if (timerState.state === 'PAUSED') {
            logger.info('LOAD', 'No active entries on server, but Timer Engine is PAUSED after wake - allowing user to resume manually');
            return;
          }
          if (timerState.state === 'RUNNING') {
            logger.info('LOAD', 'No active entries on server, but Timer Engine is RUNNING (local tracking) - not clearing');
            return;
          }
        } catch (error) {
          logger.warn('LOAD', 'Failed to check Timer Engine state before clearing', error);
          // Не очищаем при ошибке — лучше сохранить локальное состояние, чем ошибочно остановить таймер
          return;
        }
        await get().clearTrackingStateFromServer();
        return;
      }

      // SECURITY: Filter out entries that don't belong to current user
      const userEntries = activeEntries.filter(entry => entry.userId === currentUser.id);
      const foreignEntries = activeEntries.filter(entry => entry.userId !== currentUser.id);
      logger.debugTerminal('LOAD', `filter: userEntries=${userEntries.length} (ids=${userEntries.map((e) => e.id).join(',')}), foreignEntries=${foreignEntries.length}`);
      if (foreignEntries.length > 0) {
        logger.error('LOAD', `SECURITY: Found ${foreignEntries.length} active time entries belonging to other users. Current user: ${currentUser.id}, Foreign entries: ${foreignEntries.map(e => `${e.id} (user: ${e.userId})`).join(', ')}`);
      }

      if (userEntries.length === 0) {
        logger.debugTerminal('LOAD', 'early return: userEntries=0');
        // No entries for current user - check Timer Engine state before clearing
        // BUG FIX: Don't auto-stop timer if it's PAUSED or RUNNING without server entry
        try {
          const timerState = await TimerEngineAPI.getState();
          if (timerState.state === 'PAUSED') {
            logger.info('LOAD', 'No entries for current user, but Timer Engine is PAUSED after wake - allowing user to resume manually');
            return;
          }
          if (timerState.state === 'RUNNING') {
            logger.info('LOAD', 'No entries for current user, but Timer Engine is RUNNING (local tracking) - not clearing');
            return;
          }
        } catch (error) {
          logger.warn('LOAD', 'Failed to check Timer Engine state before clearing', error);
          // Не очищаем при ошибке — лучше сохранить локальное состояние
          return;
        }
        await get().clearTrackingStateFromServer();
        return;
      }

      {
        let activeEntry: TimeEntry | undefined;
        
        // FIX: Если несколько активных записей, выбираем самую свежую и останавливаем остальные
        // NOTE: userEntries уже отфильтрованы по userId текущего пользователя
        if (userEntries.length > 1) {
          logger.warn('LOAD', `Multiple active time entries for current user (${userEntries.length}), stopping duplicates. userId=${currentUser.id}, ids=${userEntries.map((e) => e.id).join(', ')}`);
          
          // Сортируем по startTime (самая свежая первая)
          const sortedEntries = [...userEntries].sort((a, b) => 
            new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          );
          
          // Выбираем самую свежую запись
          // BUG FIX: Ensure array is not empty before accessing (defensive check)
          if (sortedEntries.length === 0) {
            logger.error('LOAD', 'sortedEntries is empty after sorting, this should not happen');
            await get().clearTrackingStateFromServer();
            return;
          }
          activeEntry = sortedEntries[0];
          
          // Останавливаем все остальные активные записи (дубликаты)
          const duplicateEntries = sortedEntries.slice(1);
          for (const duplicate of duplicateEntries) {
            try {
              if (duplicate.status === 'RUNNING') {
                // Останавливаем дубликаты, которые еще работают (только свои — userEntries уже отфильтрованы)
                await api.stopTimeEntry(duplicate.id);
                logger.info('LOAD', `Stopped duplicate time entry: ${duplicate.id} (userId=${duplicate.userId})`);
              } else if (duplicate.status === 'PAUSED') {
                // Если на паузе, тоже останавливаем для консистентности
                await api.stopTimeEntry(duplicate.id);
                logger.info('LOAD', `Stopped duplicate paused entry: ${duplicate.id} (userId=${duplicate.userId})`);
              }
            } catch (error: any) {
              // Логируем ошибку, но продолжаем работу с основной записью
              logger.error('LOAD', `Failed to stop duplicate entry ${duplicate.id}`, error);
            }
          }
        } else {
          // Только одна активная запись - используем её
          // BUG FIX: Ensure array is not empty before accessing
          if (userEntries.length === 0) {
            logger.error('LOAD', 'userEntries is empty in else branch, this should not happen');
            await get().clearTrackingStateFromServer();
            return;
          }
          activeEntry = userEntries[0];
        }
        logger.debugTerminal('LOAD', `activeEntry=${activeEntry?.id ?? 'null'} status=${activeEntry?.status ?? '?'}`);
        // Validate entry data
        if (!activeEntry || !activeEntry.id || !activeEntry.startTime) {
          logger.error('LOAD', 'Invalid active entry data', activeEntry);
          return; // Skip invalid entry
        }
        
        // Check if entry is from today
        const today = new Date().toDateString();
        const entryDate = new Date(activeEntry.startTime).toDateString();
        
        // If entry is from previous day but still active, it means work continued through midnight
        // In this case, we load it but timer will show time from 00:00 of current day
        if (entryDate !== today && activeEntry.status === 'STOPPED') {
          // Entry is from previous day and stopped - don't load it
          logger.debug('LOAD', 'Stopped entry is from previous day, skipping load');
          return;
        }
        
        // Восстанавливаем Timer Engine состояние на основе time entry
        if (activeEntry.status === 'RUNNING') {
          try {
            // Сначала проверяем текущее состояние таймера
            const currentTimerState = await TimerEngineAPI.getState();
            
            // BUG FIX: Не авто-возобновляем если таймер восстановлен после wake (restored_from_running)
            // Пользователь должен сам нажать Resume после перезапуска приложения
            if (currentTimerState.state === 'PAUSED' && currentTimerState.restored_from_running) {
              logger.info('LOAD', 'Timer Engine is PAUSED after wake (restored_from_running), skipping auto-resume - user must click Resume');
              // Не вызываем resume() — только обновим store ниже
            } else if (currentTimerState.state === 'STOPPED') {
              // Таймер остановлен - запускаем
              await TimerEngineAPI.start();
            } else if (currentTimerState.state === 'PAUSED') {
              // Таймер на паузе (не после wake) - возобновляем
              await TimerEngineAPI.resume();
            } else if (currentTimerState.state === 'RUNNING') {
              // Таймер уже запущен - ничего не делаем
              // Это нормальная ситуация при восстановлении состояния
            }
          } catch (timerError: any) {
            // Если таймер уже запущен или на паузе, это нормально
            if (!timerError.message?.includes('already running') && 
                !timerError.message?.includes('already paused')) {
              logger.warn('LOAD', 'Timer Engine start failed', timerError);
            }
          }
          
          // Start activity monitoring
          try {
            await invoke('start_activity_monitoring');
          } catch (monitoringError) {
            logger.error('LOAD', 'Failed to start activity monitoring on load', monitoringError);
          }
          
          // Send heartbeat
          try {
            await api.sendHeartbeat(true);
          } catch (error) {
            logger.error('LOAD', 'Failed to send heartbeat on load', error);
          }
        } else if (activeEntry.status === 'PAUSED') {
          // Если entry на паузе, синхронизируем состояние Timer Engine
          try {
            const timerState = await TimerEngineAPI.getState();
            // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
            if (timerState.state === 'RUNNING') {
              // BUG FIX: Don't pause if user just resumed - loadActiveTimeEntry can be called from resumeTracking
              // right after resume; server may not have updated yet, causing immediate unwanted pause
              const { lastResumeTime } = get();
              const TEN_SECONDS = 10 * 1000;
              if (lastResumeTime && (Date.now() - lastResumeTime) < TEN_SECONDS) {
                logger.info('LOAD', 'Timer Engine is RUNNING but entry is PAUSED - user just resumed, skipping pause (server may not have updated yet)');
              } else {
                // Таймер работает, но entry на паузе - паузим таймер
                logger.info('LOAD', 'Timer Engine is RUNNING but entry is PAUSED, pausing timer');
                await TimerEngineAPI.pause();
                try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ } // FIX: Sync with pause — stop monitoring
              }
            } else if (timerState.state === 'STOPPED') {
              // Таймер остановлен, но entry на паузе - запускаем и сразу паузим
              // Это нужно для восстановления накопленного времени
              logger.info('LOAD', 'Timer Engine is STOPPED but entry is PAUSED, starting and pausing timer');
              try {
                await TimerEngineAPI.start();
                await TimerEngineAPI.pause();
              } catch (startError: any) {
                // Если не удалось запустить, продолжаем - Timer Engine может быть в неконсистентном состоянии
                logger.warn('LOAD', 'Failed to start timer for paused entry', startError);
              }
            }
            // Если timerState.state === 'PAUSED' - все уже синхронизировано, ничего не делаем
          } catch (timerError) {
            logger.warn('LOAD', 'Failed to sync Timer Engine state for paused entry', timerError);
            // Продолжаем - UI покажет paused entry, пользователь сможет возобновить или остановить
          }
        }
        
        // Восстанавливаем selectedProject из activeEntry.project или находим по projectId
        let restoredProject: Project | null = null;
        if (activeEntry.project) {
          // Если project включен в ответ, используем его
          restoredProject = {
            id: activeEntry.project.id,
            name: activeEntry.project.name,
            color: activeEntry.project.color,
            description: '',
            clientName: '',
            budget: 0,
            status: 'ACTIVE' as const,
            companyId: '',
            createdAt: '',
            updatedAt: '',
          };
        } else if (activeEntry.projectId) {
          // Если project не включен, но есть projectId, ищем в списке проектов
          const { projects } = get();
          const foundProject = projects.find(p => p.id === activeEntry.projectId);
          if (foundProject) {
            restoredProject = foundProject;
            logger.info('LOAD', `Found project ${foundProject.name} by projectId ${activeEntry.projectId}`);
          } else {
            logger.warn('LOAD', `Project ${activeEntry.projectId} not found in projects list`);
          }
        }
        
        // BUG FIX: Get actual Timer Engine state after synchronization
        // Timer Engine is source of truth, not server entry status
        // After syncing Timer Engine above, we should use its state
        let finalTimerState: TimerStateResponse | null = null;
        try {
          finalTimerState = await TimerEngineAPI.getState();
        } catch (error) {
          logger.warn('LOAD', 'Failed to get Timer Engine state after sync, using server status', error);
          // Fallback to server status if Timer Engine unavailable
        }
        
        // Use Timer Engine state if available, otherwise fallback to server status
        const isTracking = finalTimerState 
          ? (finalTimerState.state === 'RUNNING' || finalTimerState.state === 'PAUSED')
          : (activeEntry.status === 'RUNNING' || activeEntry.status === 'PAUSED');
        const isPaused = finalTimerState
          ? (finalTimerState.state === 'PAUSED')
          : (activeEntry.status === 'PAUSED');
        
        set({
          currentTimeEntry: activeEntry,
          isTracking: isTracking,
          isPaused: isPaused,
          selectedProject: restoredProject,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null, // FIX: Restoring from server — not idle state
        });
        if (!activeEntry.id.startsWith('temp-')) {
          invoke('persist_time_entry_id', { id: activeEntry.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
        }
        // Don't set lastActivityTime here — restore/sync is not real user activity.
        // Activity monitor will update it when user actually interacts.
      }
    } catch (error: any) {
      // BUG FIX: Log error instead of silently failing
      logger.error('LOAD', 'Failed to load active time entry', error);
      // OFFLINE FIX: When API fails, sync store from Timer Engine so UI shows correct state
      try {
        const timerState = await TimerEngineAPI.getState();
        if (timerState.state === 'RUNNING' || timerState.state === 'PAUSED') {
          const isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
          const isPaused = timerState.state === 'PAUSED';
          set({
            isTracking,
            isPaused,
            idlePauseStartTime: null,
            idlePauseStartPerfRef: null,
          });
          logger.info('LOAD', `Offline: synced store from Timer Engine (${timerState.state})`);
        }
      } catch (engineError) {
        logger.warn('LOAD', 'Failed to sync from Timer Engine after API error', engineError);
      }
    } finally {
      set({ isInitializingEntry: false });
      loadActiveTimeEntryPromise = null;
    }
  })();
  return loadActiveTimeEntryPromise;
  },

  selectProject: async (project: Project) => {
    // BUG FIX: Check actual Timer Engine state instead of store cache
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('SELECT_PROJECT', 'Failed to get Timer Engine state', error);
      // If we can't get state, use store as fallback (better than nothing)
      const { isTracking } = get();
      if (isTracking) {
        logger.info('SELECT_PROJECT', 'Stopping tracking before switching project (using store cache)');
        try {
          await get().stopTracking();
        } catch (e) {
          logger.error('SELECT_PROJECT', 'Failed to stop tracking before project switch', e);
          set({ error: 'Could not stop timer before switching project' });
          throw e;
        }
      }
      set({ selectedProject: project, error: null });
      return;
    }
    
    // Этап 2: при смене проекта во время трекинга сначала останавливаем таймер (как в Hubstaff)
    // BUG FIX: Stop even when currentTimeEntry is null (e.g. after wake) — Timer Engine is source of truth
    const isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
    if (isTracking) {
      logger.info('SELECT_PROJECT', 'Stopping tracking before switching project');
      try {
        await get().stopTracking();
      } catch (e) {
        logger.error('SELECT_PROJECT', 'Failed to stop tracking before project switch', e);
        set({ error: 'Could not stop timer before switching project' });
        throw e;
      }
    }
    set({ selectedProject: project, error: null });
  },

  startTracking: async (description?: string, fromSync?: boolean) => {
    const { selectedProject, isLoading: currentLoading } = get();
    
    // Prevent multiple simultaneous calls
    if (currentLoading) {
      return; // Already processing
    }
    
    if (!selectedProject) {
      throw new Error('No project selected');
    }

    // FIX: Fallback to useAuthStore.user — same race as loadActiveTimeEntry on app reload
    const user = getCurrentUser() ?? useAuthStore.getState().user;
    if (!user) {
      throw new Error('User not authenticated');
    }

    // BUG FIX: Set isLoading immediately after checks to prevent race condition
    // This ensures no other call can start between the check and the set
    set({ isLoading: true, error: null });
    
    // Double-check after setting isLoading (race condition protection)
    // Verify that isLoading was actually set (another call might have set it between check and set)
    const stateAfterLock = get();
    if (stateAfterLock.isLoading !== true) {
      logger.warn('START', 'Race condition detected: state changed between check and set');
      set({ isLoading: false }); // Defensive: ensure we don't leave isLoading stuck
      return;
    }

    const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
    const requestData: { projectId: string; userId: string; description?: string } = {
      projectId: selectedProject.id,
      userId: user.id,
      description: description || `Work on project ${selectedProject.name}`,
    };

    try {
      const now = Date.now();
      const nowStr = new Date(now).toISOString();
      logger.debugTerminal('START', `userId=${user.id} projectId=${selectedProject.id} fromSync=${fromSync ?? false}`);
      const optimisticEntry: TimeEntry = {
        id: `temp-${now}`,
        userId: user.id,
        projectId: selectedProject.id,
        startTime: nowStr,
        endTime: null,
        duration: 0,
        description: requestData.description || `Work on project ${selectedProject.name}`,
        status: 'RUNNING',
        createdAt: nowStr,
        updatedAt: nowStr,
        project: {
          id: selectedProject.id,
          name: selectedProject.name,
          color: selectedProject.color || '#6366f1',
        },
      };

      // OPTIMISTIC UI: показываем таймер сразу при клике (до invoke)
      const optimisticState: TimerStateResponse = {
        state: 'RUNNING',
        started_at: Math.floor(now / 1000),
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Math.floor(now / 1000),
        session_start_ms: now,
        day_start: Math.floor(now / 1000),
        today_seconds: 0,
        restored_from_running: false,
      };
      set({
        currentTimeEntry: optimisticEntry,
        isTracking: true,
        isPaused: false,
        ...(fromSync ? {} : { lastActivityTime: now, lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : now }),
        isLoading: false,
        error: null,
        localTimerStartTime: now,
        idlePauseStartTime: null,
        idlePauseStartPerfRef: null,
        lastTimerStateFromStart: optimisticState,
        clientSessionStartMs: now,
      });

      let timerState: TimerStateResponse | null = null;
      let clientStartMs: number | null = now;
      try {
        // Прямой вызов start() — без лишнего getState() (экономит ~50–100 ms)
        timerState = await TimerEngineAPI.start();
      } catch (timerError: any) {
        const msg = timerError?.message ?? '';
        if (msg.includes('already running') || msg.includes('already paused')) {
          timerState = await TimerEngineAPI.getState();
        } else if (msg.includes('Paused') || msg.includes('resume') || msg.includes('use start')) {
          try {
            timerState = await TimerEngineAPI.resume();
          } catch (_) {
            timerState = await TimerEngineAPI.getState().catch(() => null);
          }
        } else {
          const isSaveError = msg.includes('Failed to save state');
          await invoke('show_notification', {
            title: isSaveError ? 'Storage error' : 'Timer error',
            body: isSaveError ? 'Could not save timer state. Check storage.' : 'Could not start timer',
          }).catch((e) => logger.warn('START', 'Failed to show notification', e));
          timerState = await TimerEngineAPI.getState().catch((e) => {
            logger.logError('START:getState_fallback', e);
            return null;
          });
        }
      }

      const isStarted = timerState?.state === 'RUNNING' || timerState?.state === 'PAUSED' || false;

      // OPTIMISTIC: UI сразу
      set({
        currentTimeEntry: optimisticEntry,
        isTracking: isStarted,
        isPaused: timerState?.state === 'PAUSED' || false,
        ...(fromSync ? {} : { lastActivityTime: now, lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : now }),
        isLoading: false,
        error: !isStarted ? 'Could not start timer' : null,
        localTimerStartTime: isStarted ? now : null,
        idlePauseStartTime: null,
        idlePauseStartPerfRef: null,
        lastTimerStateFromStart: timerState?.state === 'RUNNING' ? timerState : null,
        clientSessionStartMs: isStarted && clientStartMs != null ? clientStartMs : null,
      });

      invoke('start_activity_monitoring').catch((e) => {
        logger.error('START', 'Failed to start activity monitoring', e);
      });

      // API в фоне: getActiveTimeEntries → restore или create
      if (isStarted) (async () => {
        let activeEntries: TimeEntry[] = [];
        try {
          activeEntries = await api.getActiveTimeEntries();
        } catch (fetchError: any) {
          logger.warn('START', 'Could not fetch active entries (offline?), creating locally', fetchError);
        }

        if (currentUser) {
          const userEntries = activeEntries.filter(entry => entry.userId === currentUser.id);
          const foreignEntries = activeEntries.filter(entry => entry.userId !== currentUser.id);
          if (foreignEntries.length > 0) {
            logger.error('START', `SECURITY: Found ${foreignEntries.length} active time entries belonging to other users`);
          }
          // CRITICAL: Use ONLY our entries. If none — clear activeEntries to skip restore/duplicate logic
          activeEntries = userEntries;
        }

        if (activeEntries.length > 0) {
          let activeEntry: TimeEntry;
        
        // FIX: Если несколько активных записей, выбираем самую свежую и останавливаем остальные
        if (activeEntries.length > 1) {
          logger.warn('LOAD', `Multiple active time entries found (${activeEntries.length}), resolving duplicates...`);
          
          // Сортируем по startTime (самая свежая первая)
          const sortedEntries = [...activeEntries].sort((a, b) => 
            new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          );
          
          // Выбираем самую свежую запись
          // BUG FIX: Ensure array is not empty before accessing
          if (sortedEntries.length === 0) {
            logger.error('START', 'sortedEntries is empty after sorting, this should not happen');
            set({ error: 'Invalid active entries data', isLoading: false });
            return;
          }
          activeEntry = sortedEntries[0];
          
          // Останавливаем все остальные активные записи (дубликаты)
          const duplicateEntries = sortedEntries.slice(1);
          for (const duplicate of duplicateEntries) {
            try {
              if (duplicate.status === 'RUNNING') {
                await api.stopTimeEntry(duplicate.id);
                logger.info('START', `Stopped duplicate time entry: ${duplicate.id}`);
              } else if (duplicate.status === 'PAUSED') {
                await api.stopTimeEntry(duplicate.id);
                logger.info('START', `Stopped duplicate paused entry: ${duplicate.id}`);
              }
            } catch (error: any) {
              logger.error('START', `Failed to stop duplicate entry ${duplicate.id}`, error);
            }
          }
        } else {
          // Только одна активная запись - используем её
          // BUG FIX: Ensure array is not empty before accessing
          if (activeEntries.length === 0) {
            logger.error('START', 'activeEntries is empty in else branch, this should not happen');
            set({ error: 'Invalid active entries data', isLoading: false });
            return;
          }
          activeEntry = activeEntries[0];
        }
        
        // If there's an active entry, check its status
        if (activeEntry.status === 'RUNNING') {
          // Already running - restore it completely
          const restoredProject = activeEntry.project ? {
            id: activeEntry.project.id,
            name: activeEntry.project.name,
            color: activeEntry.project.color,
            description: '',
            clientName: '',
            budget: 0,
            status: 'ACTIVE' as const,
            companyId: '',
            createdAt: '',
            updatedAt: '',
          } : selectedProject;
          
          // Запускаем Timer Engine (если еще не запущен)
          try {
            // Сначала проверяем текущее состояние таймера
            const currentTimerState = await TimerEngineAPI.getState();
            
            // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
            if (currentTimerState.state === 'STOPPED') {
              // Таймер остановлен - запускаем
              await TimerEngineAPI.start();
            } else if (currentTimerState.state === 'PAUSED') {
              // Таймер на паузе - возобновляем
              await TimerEngineAPI.resume();
            } else if (currentTimerState.state === 'RUNNING') {
              // Таймер уже запущен - ничего не делаем
              // Это нормальная ситуация при восстановлении состояния
            }
          } catch (timerError: any) {
            // Если таймер уже запущен, это нормально
            if (!timerError.message?.includes('already running') && 
                !timerError.message?.includes('already paused')) {
              logger.warn('START', 'Timer Engine start failed', timerError);
            }
          }
          
          // BUG FIX: Get actual Timer Engine state after synchronization
          // Timer Engine is source of truth, not server entry status
          let finalTimerState: TimerStateResponse | null = null;
          try {
            finalTimerState = await TimerEngineAPI.getState();
          } catch (error) {
            logger.warn('START', 'Failed to get Timer Engine state after sync, using server status', error);
            // Fallback to server status if Timer Engine unavailable
          }
          
          // Use Timer Engine state if available, otherwise assume RUNNING (server says RUNNING)
          const isTracking = finalTimerState 
            ? (finalTimerState.state === 'RUNNING' || finalTimerState.state === 'PAUSED')
            : true; // Server says RUNNING
          const isPaused = finalTimerState
            ? (finalTimerState.state === 'PAUSED')
            : false; // Server says RUNNING
          
          set({
            currentTimeEntry: activeEntry,
            isTracking: isTracking,
            isPaused: isPaused,
            selectedProject: restoredProject,
            isLoading: false,
            error: null,
            idlePauseStartTime: null,
  idlePauseStartPerfRef: null, // FIX: Restoring from server — not idle
          });
          if (!activeEntry.id.startsWith('temp-')) {
            invoke('persist_time_entry_id', { id: activeEntry.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
          }
          // Don't set lastActivityTime — restore is not real user activity
          // Start activity monitoring
          await invoke('start_activity_monitoring');
          
          // Send heartbeat
          await api.sendHeartbeat(true);
          
          return; // Exit - don't create new entry
        } else if (activeEntry.status === 'PAUSED') {
          // Paused - restore it and sync Timer Engine state
          const restoredProject = activeEntry.project ? {
            id: activeEntry.project.id,
            name: activeEntry.project.name,
            color: activeEntry.project.color,
            description: '',
            clientName: '',
            budget: 0,
            status: 'ACTIVE' as const,
            companyId: '',
            createdAt: '',
            updatedAt: '',
          } : selectedProject;
          
          // Синхронизируем Timer Engine с paused entry
          try {
            const timerState = await TimerEngineAPI.getState();
            // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
            if (timerState.state === 'RUNNING') {
              // BUG FIX: Don't pause if user just resumed - sync may have resumed, user clicked Start right after
              const { lastResumeTime } = get();
              const TEN_SECONDS = 10 * 1000;
              if (lastResumeTime && (Date.now() - lastResumeTime) < TEN_SECONDS) {
                logger.info('START', 'Timer Engine is RUNNING but entry is PAUSED - user just resumed, skipping pause');
              } else {
                logger.info('START', 'Timer Engine is RUNNING but entry is PAUSED, pausing timer');
                await TimerEngineAPI.pause();
              }
            } else if (timerState.state === 'STOPPED') {
              // Таймер остановлен, но entry на паузе - запускаем и сразу паузим
              // Это нужно для восстановления накопленного времени
              logger.info('START', 'Timer Engine is STOPPED but entry is PAUSED, starting and pausing timer');
              try {
                await TimerEngineAPI.start();
                await TimerEngineAPI.pause();
              } catch (startError: any) {
                // Если не удалось запустить, продолжаем - Timer Engine может быть в неконсистентном состоянии
                logger.warn('START', 'Failed to start timer for paused entry', startError);
              }
            }
            // Если timerState.state === 'PAUSED' - все уже синхронизировано, ничего не делаем
          } catch (timerError) {
            logger.warn('START', 'Failed to sync Timer Engine state for paused entry', timerError);
            // Продолжаем - UI покажет paused entry, пользователь сможет возобновить или остановить
          }
          
          // BUG FIX: Get actual Timer Engine state after synchronization
          // Timer Engine is source of truth, not server entry status
          let finalTimerState: TimerStateResponse | null = null;
          try {
            finalTimerState = await TimerEngineAPI.getState();
          } catch (error) {
            logger.warn('START', 'Failed to get Timer Engine state after sync for paused entry, using server status', error);
            // Fallback to server status if Timer Engine unavailable
          }
          
          // Use Timer Engine state if available, otherwise assume PAUSED (server says PAUSED)
          const isTracking = finalTimerState 
            ? (finalTimerState.state === 'RUNNING' || finalTimerState.state === 'PAUSED')
            : true; // Server says PAUSED, timer is active
          const isPaused = finalTimerState
            ? (finalTimerState.state === 'PAUSED')
            : true; // Server says PAUSED
          
          // Восстанавливаем состояние без error - UI покажет paused состояние с кнопками
          set({
            currentTimeEntry: activeEntry,
            isTracking: isTracking,
            isPaused: isPaused,
            selectedProject: restoredProject,
            isLoading: false,
            error: null, // Убираем error - состояние восстановлено, пользователь видит кнопки
            idlePauseStartTime: null,
  idlePauseStartPerfRef: null, // FIX: Restoring from server — not idle
          });
          if (!activeEntry.id.startsWith('temp-')) {
            invoke('persist_time_entry_id', { id: activeEntry.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
          }
          
          return; // Exit - don't create new entry
        } else {
          // Other status - stop it first
          await api.stopTimeEntry(activeEntry.id);
        }
        } else {
          // No active entries — create new
          try {
          const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
          const refreshToken = localStorage.getItem('refresh_token');
          const queueId = await invoke<number>('enqueue_time_entry', {
            operation: 'start',
            payload: requestData,
            accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => handleEnqueueError('START', e, set));
          const timeEntry = await api.startTimeEntry(requestData);
            await api.sendHeartbeat(true);
            if (queueId != null) {
              await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
            }
            const state = get();
            if (state.isTracking && state.currentTimeEntry?.id?.startsWith('temp-')) {
              set({
                currentTimeEntry: timeEntry,
                localTimerStartTime: null,
              });
              invoke('persist_time_entry_id', { id: timeEntry.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
            }
          } catch (apiError: any) {
            if (apiError.message?.includes('already running') ||
                apiError.message?.includes('User already has')) {
              try {
                const activeEntries = await api.getActiveTimeEntries();
                const userEntries = activeEntries.filter(e => e.userId === user.id);
                const activeEntry = userEntries[0];
                if (!activeEntry) return;
                set({
                  currentTimeEntry: activeEntry,
                  localTimerStartTime: null,
                  error: null,
                  idlePauseStartTime: null,
                  idlePauseStartPerfRef: null,
                });
                return;
              } catch (_) {}
            }
            // OFFLINE FIX: Don't stop timer — enqueue already happened, sync will create entry when online
            logger.warn('START', 'API failed (background), queue will retry', apiError);
            set({
              error: 'Will sync when online',
            });
            invoke('show_notification', {
              title: 'Offline',
              body: 'Timer running. Will sync when online.',
            }).catch(() => {});
          }
        }
      })();
    } catch (error: any) {
      // BUG FIX: При ошибке API нужно проверить, была ли запись создана
      // Если запись создана, но произошла ошибка, нужно синхронизировать состояние
      const errorMsg = error.message || 'Failed to start tracking';
      const entryCreated = errorMsg.includes('already running') || errorMsg.includes('User already has');
      
      // BUG FIX: Clear localTimerStartTime if API failed and entry was not created
      // This prevents syncTimerState from incorrectly protecting a timer that shouldn't be running
      if (!entryCreated) {
        set({ localTimerStartTime: null });
      }
      
      if (entryCreated) {
        // Запись уже существует - пытаемся синхронизировать состояние
        try {
          const currentUserForSync = getCurrentUser() ?? useAuthStore.getState().user;
          if (!currentUserForSync) return;
          const activeEntries = await api.getActiveTimeEntries();
          const userEntries = activeEntries.filter((e) => e.userId === currentUserForSync.id);
          if (userEntries.length > 0) {
            const activeEntry = userEntries[0];
            const timerState = await TimerEngineAPI.getState();
            set({
              currentTimeEntry: activeEntry,
              isTracking: timerState.state === 'RUNNING' || timerState.state === 'PAUSED',
              isPaused: timerState.state === 'PAUSED',
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
  idlePauseStartPerfRef: null, // FIX: Syncing to existing entry — not idle
            });
            return;
          }
        } catch (syncError) {
          logger.error('START', 'Failed to sync state after API error', syncError);
        }
      }
      
      set({ error: errorMsg, isLoading: false });
      throw error;
    }
  },

  pauseTracking: async (isIdlePause: boolean = false) => {
    const { isLoading: currentLoading } = get();

    // GUARD: Prevent multiple simultaneous calls - устанавливаем isLoading СРАЗУ
    if (currentLoading) {
      invoke('log_message', { message: '[PAUSE] Already loading, skipping' }).catch((e) => {
        logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
      });
      return;
    }
    
    // Устанавливаем isLoading СРАЗУ для защиты от race condition
    set({ isLoading: true });
    
    // BUG FIX: Check Timer Engine state first - it's the source of truth
    // If Timer Engine is RUNNING but currentTimeEntry is missing, try to load it or pause Timer Engine anyway
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
      if (timerState.state === 'PAUSED' && !isIdlePause) {
        set({ isLoading: false, idlePauseStartTime: null }); // FIX: Manual pause — not idle
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
        invoke('log_message', { message: '[PAUSE] Already paused (Timer Engine check), skipping' }).catch((e) => {
          logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
        });
        return;
      }
      if (timerState.state === 'STOPPED') {
        const entry = get().currentTimeEntry;
        if (entry && !entry.id.startsWith('temp-')) {
          // Движок остановлен, но есть запись — синхронизируем stop с сервером
          set({ isLoading: false });
          (async () => {
            try {
              const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
              const refreshToken = localStorage.getItem('refresh_token');
              const queueId = await invoke<number>('enqueue_time_entry', {
                operation: 'stop',
                payload: { id: entry.id },
                accessToken,
                refreshToken: refreshToken || null,
              }).catch((e) => handleEnqueueError('PAUSE', e, set));
              await api.stopTimeEntry(entry.id);
              await api.sendHeartbeat(false);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
              }
            } catch (e: any) {
              logger.warn('PAUSE', 'API stop failed (engine STOPPED)', e);
            }
          })();
        }
        set({
          isLoading: false,
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          lastResumeTime: null,
          localTimerStartTime: null,
        });
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e)); // FIX: Idle window must be hidden when STOPPED
        await logger.safeLogToRust('[PAUSE] Timer Engine is STOPPED, syncing store').catch((e) => {
          logger.debug('PAUSE', 'Failed to log (non-critical)', e);
        });
        return;
      }
    } catch (error) {
      logger.warn('PAUSE', 'Failed to get Timer Engine state', error);
      set({ isLoading: false });
      return; // Can't pause if we can't check Timer Engine state
    }

    // BUG FIX: If Timer Engine is RUNNING but currentTimeEntry is missing, try to load it
    let timeEntryToPause = get().currentTimeEntry;
    if (!timeEntryToPause && timerState.state === 'RUNNING') {
      logger.info('PAUSE', 'Timer Engine is RUNNING but no currentTimeEntry - trying to load active entry');
      try {
        await get().loadActiveTimeEntry();
        timeEntryToPause = get().currentTimeEntry;
        if (!timeEntryToPause) {
          logger.warn('PAUSE', 'Failed to load active entry, but Timer Engine is RUNNING - pausing Timer Engine anyway');
          // Continue with pause - Timer Engine is source of truth, we'll pause it even without entry
        }
      } catch (loadError) {
        logger.warn('PAUSE', 'Failed to load active entry', loadError);
        // Continue with pause - Timer Engine is source of truth
      }
    }
    
    // BUG FIX: If still no timeEntryToPause but Timer Engine is RUNNING, try to sync with server first
    // loadActiveTimeEntry might have failed (network) or store might be desynced — API might have RUNNING entry
    if (!timeEntryToPause && timerState.state === 'RUNNING') {
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
      logger.debugTerminal('PAUSE', `no currentEntry, fetching. userId=${currentUser?.id}`);
      if (currentUser) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          const userEntries = activeEntries.filter((e) => e.userId === currentUser.id);
          const runningEntry = userEntries.find((e) => e.status === 'RUNNING');
          if (runningEntry) {
            logger.info('PAUSE', `Found RUNNING entry on server (${runningEntry.id}), syncing pause`);
            await TimerEngineAPI.pause();
            const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
            const refreshToken = localStorage.getItem('refresh_token');
            const queueId = await invoke<number>('enqueue_time_entry', {
              operation: 'pause',
              payload: { id: runningEntry.id },
              accessToken,
              refreshToken: refreshToken || null,
            }).catch((e) => handleEnqueueError('PAUSE', e, set));
            try {
              await api.pauseTimeEntry(runningEntry.id);
              await api.sendHeartbeat(false);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
              }
            } catch (apiErr: any) {
              logger.warn('PAUSE', 'API pause failed (will retry via queue)', apiErr);
            }
            set({
              currentTimeEntry: { ...runningEntry, status: 'PAUSED' },
              isPaused: true,
              isTracking: true,
              isLoading: false,
              error: null,
              idlePauseStartTime: isIdlePause ? Date.now() : null,
              idlePauseStartPerfRef: isIdlePause ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : null,
            });
            await invoke('stop_activity_monitoring').catch(e => logger.error('INVOKE', 'stop_activity_monitoring failed', e));
            return;
          }
        } catch (fetchErr) {
          logger.warn('PAUSE', 'Failed to fetch active entries for pause sync', fetchErr);
        }
      }
      logger.info('PAUSE', 'Pausing Timer Engine without time entry (no RUNNING entry on server)');
      try {
        if (isIdlePause && timerState?.state === 'RUNNING') {
          const { lastActivityTime, clientSessionStartMs } = get();
          const sessionStartMs = timerState.session_start_ms ?? clientSessionStartMs ?? (timerState.session_start != null ? timerState.session_start * 1000 : 0);
          const sessionStartSec = sessionStartMs / 1000;
          if (sessionStartSec > 0) {
            const workElapsedSecs = Math.max(
              0,
              Math.min(
                Math.floor(lastActivityTime / 1000 - sessionStartSec),
                (timerState.elapsed_seconds ?? 0) - (timerState.accumulated_seconds ?? 0)
              )
            );
            await TimerEngineAPI.pauseIdle(workElapsedSecs);
          } else {
            await TimerEngineAPI.pause();
          }
        } else {
          await TimerEngineAPI.pause();
        }
        const pausedState = await TimerEngineAPI.getState();
        if (pausedState.state === 'PAUSED') {
          // FIX: Try to load any active entry (PAUSED) so Stop will have ID for queue/API
          let entryForStop: import('../lib/api').TimeEntry | null = null;
          try {
            const activeEntries = await api.getActiveTimeEntries();
            const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
            if (currentUser) {
              const anyEntry = activeEntries.find((e) => e.userId === currentUser.id);
              if (anyEntry) entryForStop = anyEntry;
            }
          } catch (_) {}
          // FIX: При офлайне API не доступен — используем сохранённый ID для enqueue
          if (!entryForStop) {
            const lastId = await invoke<string | null>('get_last_time_entry_id').catch(() => null);
            if (lastId && !lastId.startsWith('temp-')) {
              const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
              const refreshToken = localStorage.getItem('refresh_token');
              await invoke<number>('enqueue_time_entry', {
                operation: 'pause',
                payload: { id: lastId },
                accessToken,
                refreshToken: refreshToken || null,
              }).catch((e) => handleEnqueueError('PAUSE', e, set));
            }
          }
          set({
            isPaused: true,
            isTracking: true,
            isLoading: false,
            error: null,
            idlePauseStartTime: isIdlePause ? Date.now() : null,
            idlePauseStartPerfRef: isIdlePause ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : null,
            ...(entryForStop ? { currentTimeEntry: entryForStop } : {}),
          });
          await invoke('stop_activity_monitoring').catch(e => logger.error('INVOKE', 'stop_activity_monitoring failed', e));
          await logger.safeLogToRust('[PAUSE] Timer Engine paused without time entry').catch(() => {});
          return;
        } else {
          logger.warn('PAUSE', `Timer Engine pause called but state is ${pausedState.state}, not PAUSED`);
          // Fall through to error handling
        }
      } catch (pauseError: any) {
        logger.error('PAUSE', 'Failed to pause Timer Engine without entry', pauseError);
        // BUG FIX: Check Timer Engine state - it might have paused successfully despite error
        try {
          const actualTimerState = await TimerEngineAPI.getState();
          if (actualTimerState.state === 'PAUSED') {
            // Timer Engine was paused successfully - sync state, clear error
            logger.info('PAUSE', 'Timer Engine paused successfully despite error - syncing state');
            set({
              isPaused: true,
              isTracking: true, // Timer is active, just paused
              isLoading: false,
              error: null,
              idlePauseStartTime: isIdlePause ? Date.now() : null,
              idlePauseStartPerfRef: isIdlePause ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : null,
            });
            await invoke('stop_activity_monitoring').catch(e => logger.error('INVOKE', 'stop_activity_monitoring failed', e));
            return;
          }
        } catch (stateError) {
          logger.warn('PAUSE', 'Failed to check Timer Engine state after pause error', stateError);
        }
        // Timer Engine is not paused - show error
        set({ isLoading: false, error: 'Could not pause timer' });
        return;
      }
    }
    
    // If we still don't have timeEntryToPause and Timer Engine is not RUNNING, we can't proceed
    // But if Timer Engine is RUNNING, we should have paused it above
    if (!timeEntryToPause) {
      // Re-check Timer Engine state - it might have changed
      try {
        const finalTimerState = await TimerEngineAPI.getState();
        if (finalTimerState.state === 'RUNNING') {
          // Timer Engine is still RUNNING but we don't have entry - try to pause anyway
          logger.warn('PAUSE', 'Timer Engine is RUNNING but no entry - attempting pause anyway');
          try {
            if (isIdlePause && finalTimerState.state === 'RUNNING') {
              const { lastActivityTime, clientSessionStartMs } = get();
              const sessionStartMs = finalTimerState.session_start_ms ?? clientSessionStartMs ?? (finalTimerState.session_start != null ? finalTimerState.session_start * 1000 : 0);
              const sessionStartSec = sessionStartMs / 1000;
              if (sessionStartSec > 0) {
                const workElapsedSecs = Math.max(
                  0,
                  Math.min(
                    Math.floor(lastActivityTime / 1000 - sessionStartSec),
                    (finalTimerState.elapsed_seconds ?? 0) - (finalTimerState.accumulated_seconds ?? 0)
                  )
                );
                await TimerEngineAPI.pauseIdle(workElapsedSecs);
              } else {
                await TimerEngineAPI.pause();
              }
            } else {
              await TimerEngineAPI.pause();
            }
            const pausedState = await TimerEngineAPI.getState();
            set({
              isPaused: pausedState.state === 'PAUSED',
              isTracking: pausedState.state === 'PAUSED',
              isLoading: false,
              error: null,
              idlePauseStartTime: isIdlePause ? Date.now() : null,
            });
            await invoke('stop_activity_monitoring').catch(e => logger.error('INVOKE', 'stop_activity_monitoring failed', e));
            return;
          } catch (finalPauseError) {
            logger.error('PAUSE', 'Final attempt to pause Timer Engine failed', finalPauseError);
            set({ isLoading: false, error: 'Could not pause timer' });
            return;
          }
        }
      } catch (stateCheckError) {
        logger.warn('PAUSE', 'Failed to re-check Timer Engine state', stateCheckError);
      }
      set({ isLoading: false });
      await logger.safeLogToRust('[PAUSE] No current time entry and Timer Engine is not RUNNING, skipping').catch((e) => {
        logger.debug('PAUSE', 'Failed to log (non-critical)', e);
      });
      return;
    }

    await invoke('log_message', { message: `[PAUSE] Starting pause for timeEntry: ${timeEntryToPause.id}, isIdlePause: ${isIdlePause}` }).catch((e) => {
      logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
    });

    if (!timeEntryToPause.id.startsWith('temp-')) {
      invoke('persist_time_entry_id', { id: timeEntryToPause.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
    }

    try {
      set({ error: null }); // Clear previous errors (isLoading уже установлен выше)
      
      // Re-check currentTimeEntry before using it
      const finalTimeEntryToPause = get().currentTimeEntry;
      if (!finalTimeEntryToPause || !timeEntryToPause || finalTimeEntryToPause.id !== timeEntryToPause.id) {
        set({ isLoading: false });
        await logger.safeLogToRust('[PAUSE] Current time entry changed or disappeared, aborting pause').catch((e) => {
          logger.debug('PAUSE', 'Failed to log (non-critical)', e);
        });
        return;
      }
      timeEntryToPause = finalTimeEntryToPause;
      const entryIdToPause = timeEntryToPause.id;
      
      // OPTIMISTIC: Сначала паузим Timer Engine (локально) и сразу обновляем UI
      // Как в Hubstaff — UI реагирует мгновенно, API в фоне
      // Idle: исключаем время простоя — используем lastActivityTime вместо now
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        if (isIdlePause) {
          const { lastActivityTime } = get();
          const preState = await TimerEngineAPI.getState();
          if (preState.state === 'RUNNING') {
            const { clientSessionStartMs } = get();
            const sessionStartMs = preState.session_start_ms ?? clientSessionStartMs ?? (preState.session_start != null ? preState.session_start * 1000 : 0);
            const sessionStartSec = sessionStartMs / 1000;
            if (sessionStartSec > 0) {
              const workElapsedSecs = Math.max(
                0,
                Math.min(
                  Math.floor(lastActivityTime / 1000 - sessionStartSec),
                  preState.elapsed_seconds - preState.accumulated_seconds
                )
              );
              timerState = await TimerEngineAPI.pauseIdle(workElapsedSecs);
            } else {
              timerState = await TimerEngineAPI.pause();
            }
          } else {
            timerState = await TimerEngineAPI.pause();
          }
        } else {
          timerState = await TimerEngineAPI.pause();
        }
      } catch (timerError: any) {
        if (timerError.message?.includes('already paused') || 
            timerError.message?.includes('stopped') ||
            timerError.message?.includes('Cannot pause')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          const msg = timerError?.message ?? '';
          const isSaveError = msg.includes('Failed to save state');
          await invoke('show_notification', {
            title: isSaveError ? 'Storage error' : 'Timer error',
            body: isSaveError ? 'Could not save timer state. Check storage.' : 'Could not pause timer',
          }).catch((e) => {
            logger.warn('PAUSE', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch((e) => {
            logger.logError('PAUSE:getState_fallback', e);
            return null;
          });
        }
      }
      
      const pauseStartTime = isIdlePause ? Date.now() : null;
      const pausePerfRef = isIdlePause ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : null;
      const isPaused = timerState?.state === 'PAUSED' || false;
      
      // OPTIMISTIC: Обновляем UI сразу после Timer Engine — без ожидания API
      set({
        currentTimeEntry: timeEntryToPause,
        isPaused: isPaused,
        isLoading: false,
        error: !isPaused ? 'Could not pause' : null,
        localTimerStartTime: null,
        idlePauseStartTime: pauseStartTime,
        idlePauseStartPerfRef: pausePerfRef,
        lastTimerStateFromStart: null,
        clientSessionStartMs: null,
      });
      
      // Stop monitoring immediately (local, fast)
      invoke('stop_activity_monitoring').catch((e) => {
        logger.debug('PAUSE', 'Failed to stop activity monitoring (non-critical)', e);
      });
      
      // API в фоне, только если пауза успешна (пропускаем temp id — запись ещё не создана)
      // FIX: Enqueue СРАЗУ (до любых сетевых вызовов), чтобы при офлайне задача попадала в очередь
      // Токен не нужен для enqueue (Rust получает его при sync), но передаём для совместимости
      let queueIdPause: number | null = null;
      if (isPaused && !entryIdToPause.startsWith('temp-')) {
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
        const refreshToken = localStorage.getItem('refresh_token');
        queueIdPause = await invoke<number>('enqueue_time_entry', {
          operation: 'pause',
          payload: { id: entryIdToPause },
          accessToken,
          refreshToken: refreshToken || null,
        }).catch((e) => handleEnqueueError('PAUSE', e, set));
      }
      if (isPaused) logger.debugTerminal('PAUSE', `entryIdToPause=${entryIdToPause} userId=${timeEntryToPause?.userId ?? '?'}`);
      if (isPaused && !entryIdToPause.startsWith('temp-')) (async () => {
        try {
          await get().sendUrlActivities();
        } catch (e) {
          logger.warn('PAUSE', 'Failed to send URL activities (background)', e);
        }
        try {
          const queueId = queueIdPause;
          await api.pauseTimeEntry(entryIdToPause);
          await api.sendHeartbeat(false);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
          }
        } catch (apiError: any) {
          if (apiError.message?.includes('Only running entries can be paused') ||
              apiError.message?.includes('already paused')) {
            return;
          }
          logger.warn('PAUSE', 'API failed (background), queue will retry', apiError);
          invoke('show_notification', {
            title: 'Sync',
            body: 'Pause completed, but could not sync with server',
          }).catch(e => logger.error('INVOKE', 'show_notification failed', e));
        }
      })();
      
      const stateAfterPause = get();
      
      // FIX: Проверяем после set - если это был idle pause, но isPaused не установился, 
      // это означает, что пауза не удалась, очищаем idlePauseStartTime
      if (isIdlePause && !stateAfterPause.isPaused) {
        logger.warn('PAUSE', `Idle pause requested but isPaused is false, clearing idlePauseStartTime`);
        set({ idlePauseStartTime: null });
      } else if (isIdlePause && stateAfterPause.isPaused && !stateAfterPause.idlePauseStartTime) {
        // FIX: Если это был idle pause, isPaused установился, но idlePauseStartTime не установлен - устанавливаем его
        logger.warn('PAUSE', `Idle pause successful but idlePauseStartTime not set, setting it now`);
        set({ idlePauseStartTime: Date.now(), idlePauseStartPerfRef: typeof performance !== 'undefined' ? performance.now() : Date.now() });
      }
      
      await logger.safeLogToRust(`[PAUSE] State after pause: isTracking=${stateAfterPause.isTracking}, isPaused=${stateAfterPause.isPaused}, isLoading=${stateAfterPause.isLoading}, idlePauseStartTime=${stateAfterPause.idlePauseStartTime}`).catch((e) => {
        logger.debug('PAUSE', 'Failed to log (non-critical)', e);
      });
    } catch (error: any) {
      logger.error('PAUSE', 'Failed to pause tracking', error);
      const msg = error.message || 'Failed to pause tracking';
      const alreadyStopped = typeof msg === 'string' && (msg.includes('already stopped') || msg.includes('not found'));
      if (alreadyStopped) {
        try { 
          await TimerEngineAPI.stop(); 
        } catch (stopError) { 
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('PAUSE', 'Timer Engine already stopped (non-critical)', stopError);
        }
        try { 
          await invoke('stop_activity_monitoring'); 
        } catch (monitoringError) { 
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('PAUSE', 'Activity monitoring already stopped (non-critical)', monitoringError);
        }
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          lastResumeTime: null,
          localTimerStartTime: null,
        });
        try { 
          await invoke('hide_idle_window'); 
        } catch (hideError) { 
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('PAUSE', 'Idle window already hidden (non-critical)', hideError);
        }
      } else {
        // Проверяем реальное состояние Timer Engine при ошибке
        // BUG FIX: If Timer Engine was paused successfully, sync state and clear error
        try {
          const timerState = await TimerEngineAPI.getState();
          // Синхронизируем состояние с Timer Engine
          const wasPausedSuccessfully = timerState.state === 'PAUSED';
          set({
            isPaused: timerState.state === 'PAUSED',
            isTracking: timerState.state === 'RUNNING' || timerState.state === 'PAUSED',
            isLoading: false,
            error: wasPausedSuccessfully ? null : msg, // Clear error if pause was successful
            idlePauseStartTime: (timerState.state === 'PAUSED' && isIdlePause) ? Date.now() : null,
            idlePauseStartPerfRef: (timerState.state === 'PAUSED' && isIdlePause) ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : null,
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, idlePauseStartTime: null, idlePauseStartPerfRef: null, lastResumeTime: null, localTimerStartTime: null } : {}),
          });
          if (wasPausedSuccessfully) {
            logger.info('PAUSE', 'Timer Engine paused successfully despite API error - state synced, error cleared');
            try {
              await invoke('stop_activity_monitoring');
            } catch (e) {
              logger.debug('PAUSE', 'Failed to stop activity monitoring (non-critical)', e);
            }
          }
        } catch (e) {
          // Если не удалось проверить Timer Engine, только устанавливаем ошибку
          logger.warn('PAUSE', 'Failed to check Timer Engine state after error', e);
          set({ error: msg, isLoading: false });
        }
        try {
          await invoke('stop_activity_monitoring');
        } catch (e) {
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('PAUSE', 'Failed to stop activity monitoring in error handler (non-critical)', e);
        }
      }
    }
  },

  resumeTracking: async (_fromIdleWindow: boolean = false, fromSync: boolean = false) => {
    const { currentTimeEntry: initialTimeEntry, isLoading: currentLoading } = get();
    
    // Prevent multiple simultaneous calls
    if (currentLoading) {
      return;
    }
    
    // BUG FIX: Set isLoading immediately to prevent race (parallel resume calls)
    set({ isLoading: true, error: null });
    
    // NOTE: We removed the idlePauseStartTime check here because:
    // 1. Automatic resume from syncTimerState is already protected by a check in App.tsx (line 213)
    // 2. Explicit user actions (clicking Resume button) should always be allowed
    // 3. The fromIdleWindow parameter is still used for clarity/logging but doesn't block resume
    
    // BUG FIX: Check actual Timer Engine state instead of store cache
    // Store cache can be stale, Timer Engine is source of truth
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('RESUME', 'Failed to get Timer Engine state', error);
      // If we can't get state, use store as fallback
      const { isPaused } = get();
      if (!isPaused) {
        await logger.safeLogToRust('[RESUME] Already running, skipping (using store cache)').catch((e) => {
          logger.debug('RESUME', 'Failed to log (non-critical)', e);
        });
        set({ isLoading: false, idlePauseStartTime: null }); // FIX: Clear idle — we're running
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
        return;
      }
    }
    
    // Prevent resuming if already running (not paused)
    const isPaused = timerState ? timerState.state === 'PAUSED' : get().isPaused;
    if (!isPaused) {
      await logger.safeLogToRust('[RESUME] Already running, skipping').catch((e) => {
        logger.debug('RESUME', 'Failed to log (non-critical)', e);
      });
      set({ isLoading: false, idlePauseStartTime: null }); // FIX: Clear idle — we're running
      invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
      return;
    }

    // BUG FIX: Allow resuming Timer Engine even without currentTimeEntry
    // Timer Engine is the source of truth - if it's PAUSED, user should be able to resume
    // This handles cases like system wake when timer was paused but entry wasn't loaded
    if (!initialTimeEntry) {
      logger.info('RESUME', 'No currentTimeEntry, but Timer Engine is PAUSED - resuming Timer Engine only');
      try {
        // FIX: Enqueue resume СРАЗУ (до loadActiveTimeEntry), используя сохранённый ID — при офлайне loadActiveTimeEntry не успеет
        const lastId = await invoke<string | null>('get_last_time_entry_id').catch(() => null);
        let queueIdFromEnqueue: number | null = null;
        if (lastId && !lastId.startsWith('temp-')) {
          const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
          const refreshToken = localStorage.getItem('refresh_token');
          queueIdFromEnqueue = await invoke<number>('enqueue_time_entry', {
            operation: 'resume',
            payload: { id: lastId },
            accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => handleEnqueueError('RESUME', e, set));
        }
        // Resume Timer Engine directly
        await TimerEngineAPI.resume();
        // Update store state
        const newTimerState = await TimerEngineAPI.getState();
        const resumeTimeNoEntry = Date.now();
        set({
          isPaused: false,
          isTracking: newTimerState.state === 'RUNNING',
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          ...(fromSync ? {} : { lastActivityTime: resumeTimeNoEntry }), // Don't reset when from sync — not real user activity
          lastResumeTime: resumeTimeNoEntry, // BUG FIX: Track resume time to prevent sync from pausing immediately after resume
          localTimerStartTime: resumeTimeNoEntry, // BUG FIX: Track local resume time to prevent auto-pause from syncTimerState
        });
        invoke('start_activity_monitoring').catch((e) => {
          logger.error('RESUME', 'Failed to start activity monitoring on resume (no entry)', e);
        });
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
        // BUG FIX: Await loadActiveTimeEntry before reading currentTimeEntry — otherwise entryAfterLoad is always null
        await get().loadActiveTimeEntry().catch((e) => logger.warn('RESUME', 'loadActiveTimeEntry failed', e));
        // FIX: Sync resume with server — loadActiveTimeEntry может установить entry, тогда API вызов в фоне
        const entryAfterLoad = get().currentTimeEntry;
        if (entryAfterLoad && !entryAfterLoad.id.startsWith('temp-')) {
          (async () => {
            try {
              const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
              const refreshToken = localStorage.getItem('refresh_token');
              let queueId: number | null = queueIdFromEnqueue;
              // BUG FIX: Don't double-enqueue when we already enqueued with lastId === entryAfterLoad.id
              if (queueId == null || lastId !== entryAfterLoad.id) {
                queueId = null;
                if (accessToken) {
                  queueId = await invoke<number>('enqueue_time_entry', {
                    operation: 'resume',
                    payload: { id: entryAfterLoad.id },
                    accessToken,
                    refreshToken: refreshToken || null,
                  }).catch((e) => handleEnqueueError('RESUME', e, set));
                }
              }
              await api.resumeTimeEntry(entryAfterLoad.id);
              await api.sendHeartbeat(true);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
              }
            } catch (e: any) {
              if (!e?.message?.includes('already running') && !e?.message?.includes('Only paused entries')) {
                logger.warn('RESUME', 'API resume failed (no-entry branch)', e);
              }
            }
          })();
        }
      } catch (error: any) {
        logger.error('RESUME', 'Failed to resume Timer Engine without entry', error);
        set({
          isLoading: false,
          error: error?.message || 'Failed to resume timer',
        });
      }
      return;
    }

    // Double-check after setting isLoading (race condition protection)
    const stateAfterLock = get();
    if (stateAfterLock.isLoading !== true) {
      logger.warn('RESUME', 'Race condition detected: state changed between check and set');
      set({ isLoading: false }); // Defensive: ensure we don't leave isLoading stuck
      return;
    }

    // BUG FIX: Re-check currentTimeEntry after setting isLoading
    // It may have changed between initial check and now
    let timeEntryToResume = get().currentTimeEntry;
    if (!timeEntryToResume || timeEntryToResume.id !== initialTimeEntry.id) {
      set({ isLoading: false });
      await logger.safeLogToRust('[RESUME] Current time entry changed or disappeared, aborting resume').catch((e) => {
        logger.debug('RESUME', 'Failed to log (non-critical)', e);
      });
      return;
    }

    try {
      const entryIdToResume = timeEntryToResume.id;
      const clientResumeMs = Date.now();
      // OPTIMISTIC UI: показываем RUNNING сразу (используем elapsed из timerState проверки выше)
      const optimisticResumeState: TimerStateResponse = timerState ? {
        state: 'RUNNING',
        started_at: Math.floor(clientResumeMs / 1000),
        elapsed_seconds: timerState.elapsed_seconds,
        accumulated_seconds: timerState.accumulated_seconds,
        session_start: Math.floor(clientResumeMs / 1000),
        session_start_ms: clientResumeMs,
        day_start: timerState.day_start ?? Math.floor(clientResumeMs / 1000),
        today_seconds: timerState.today_seconds ?? timerState.elapsed_seconds,
        restored_from_running: false,
      } : {
        state: 'RUNNING',
        started_at: Math.floor(clientResumeMs / 1000),
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Math.floor(clientResumeMs / 1000),
        session_start_ms: clientResumeMs,
        day_start: Math.floor(clientResumeMs / 1000),
        today_seconds: 0,
        restored_from_running: false,
      };
      set({
        isPaused: false,
        isTracking: true,
        lastActivityTime: clientResumeMs,
        lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : clientResumeMs,
        isLoading: false,
        error: null,
        idlePauseStartTime: null,
        idlePauseStartPerfRef: null,
        lastResumeTime: clientResumeMs,
        localTimerStartTime: clientResumeMs,
        lastTimerStateFromStart: optimisticResumeState,
        clientSessionStartMs: clientResumeMs,
      });

      let resumeTimerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        resumeTimerState = await TimerEngineAPI.resume();
      } catch (resumeError: any) {
        if (resumeError?.message?.includes('already running')) {
          resumeTimerState = await TimerEngineAPI.getState();
        } else {
          const msg = resumeError?.message ?? '';
          const isSaveError = msg.includes('Failed to save state');
          await invoke('show_notification', {
            title: isSaveError ? 'Storage error' : 'Timer error',
            body: isSaveError ? 'Could not save timer state. Check storage.' : 'Could not resume timer',
          }).catch((e) => logger.warn('RESUME', 'Failed to show notification', e));
          resumeTimerState = await TimerEngineAPI.getState().catch(() => null);
        }
      }

      const isResumed = resumeTimerState?.state === 'RUNNING' || false;
      const resumeTime = Date.now();
      const isPausedActual = resumeTimerState?.state === 'PAUSED' || false;
      const isTrackingActual = resumeTimerState?.state === 'RUNNING' || resumeTimerState?.state === 'PAUSED' || false;
      set({
        currentTimeEntry: timeEntryToResume,
        isPaused: isResumed ? false : isPausedActual,
        isTracking: isResumed ? true : isTrackingActual,
        ...(fromSync ? {} : { lastActivityTime: resumeTime, lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : resumeTime }),
        isLoading: false,
        error: !isResumed ? 'Could not resume timer' : null,
        idlePauseStartTime: isResumed ? null : (get().idlePauseStartTime ?? null),
        lastResumeTime: isResumed ? resumeTime : get().lastResumeTime,
        localTimerStartTime: isResumed ? resumeTime : get().localTimerStartTime,
        lastTimerStateFromStart: resumeTimerState?.state === 'RUNNING' ? resumeTimerState : null,
        clientSessionStartMs: isResumed ? clientResumeMs : null,
      });
      if (!timeEntryToResume.id.startsWith('temp-')) {
        invoke('persist_time_entry_id', { id: timeEntryToResume.id }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
      }
      
      if (isResumed) {
        invoke('start_activity_monitoring').catch((e) => {
          logger.error('RESUME', 'Failed to start activity monitoring on resume', e);
        });
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
      }
      
      // FIX: Enqueue СРАЗУ (до любых сетевых вызовов), чтобы при офлайне задача попадала в очередь
      // Токен не нужен для enqueue (Rust получает его при sync), но передаём для совместимости
      let queueIdResume: number | null = null;
      if (isResumed && !entryIdToResume.startsWith('temp-')) {
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
        const refreshToken = localStorage.getItem('refresh_token');
        queueIdResume = await invoke<number>('enqueue_time_entry', {
          operation: 'resume',
          payload: { id: entryIdToResume },
          accessToken,
          refreshToken: refreshToken || null,
        }).catch((e) => handleEnqueueError('RESUME', e, set));
      }
      
      // API в фоне: проверка сервера + resume
      if (isResumed && !entryIdToResume.startsWith('temp-')) (async () => {
        try {
          // Проверка статуса на сервере (для reconcile)
          const activeEntries = await api.getActiveTimeEntries();
          const serverEntry = activeEntries.find(e => e.id === entryIdToResume);
          if (serverEntry?.status === 'STOPPED') {
            logger.info('RESUME', 'Entry is STOPPED on server, syncing local state');
            try {
              const engineState = await TimerEngineAPI.getState();
              if (engineState.state !== 'STOPPED') {
                await TimerEngineAPI.stop();
              }
            } catch (e) {
              logger.warn('RESUME', 'Failed to stop Timer Engine when entry is STOPPED on server', e);
            }
            set({
              currentTimeEntry: null,
              isPaused: false,
              isTracking: false,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
              idlePauseStartPerfRef: null,
              lastResumeTime: null,
              localTimerStartTime: null,
            });
            invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
            try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ }
            return;
          }
          if (serverEntry?.status === 'RUNNING') {
            set({ currentTimeEntry: serverEntry });
          }
          const queueId = queueIdResume;
          await api.resumeTimeEntry(entryIdToResume);
          await api.sendHeartbeat(true);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
          }
        } catch (apiError: any) {
          if (apiError.message?.includes('already running') ||
              apiError.message?.includes('Only paused entries can be resumed')) {
            return;
          }
          logger.warn('RESUME', 'API failed (background), queue will retry', apiError);
          invoke('show_notification', {
            title: 'Sync',
            body: 'Timer resumed, but could not sync with server',
          }).catch(() => {});
        }
      })();
    } catch (error: any) {
      const msg = error.message || 'Failed to resume tracking';
      const needSyncFromServer = typeof msg === 'string' && (msg.includes('already running') || msg.includes('Only paused entries can be resumed'));
      const entryStoppedOrGone = typeof msg === 'string' && (msg.includes('already stopped') || msg.includes('not found') || msg.includes('Invalid resume') || msg.includes('Only paused entries can be resumed'));
      if (needSyncFromServer) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          const serverEntry = activeEntries.find(e => e.id === timeEntryToResume.id);
          if (serverEntry?.status === 'RUNNING') {
            try { await TimerEngineAPI.resume(); } catch (_) { /* already running */ }
            // BUG FIX: Get actual Timer Engine state to ensure isTracking is correct
            const actualTimerState = await TimerEngineAPI.getState().catch(() => null);
            const isTracking = actualTimerState?.state === 'RUNNING' || actualTimerState?.state === 'PAUSED' || true; // Default to true if can't get state
            const resumeTimeForSync = Date.now();
            set({
              currentTimeEntry: serverEntry,
              isPaused: false,
              isTracking: isTracking,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
              lastResumeTime: resumeTimeForSync, // BUG FIX: Track resume time to prevent sync from pausing immediately after resume
              localTimerStartTime: resumeTimeForSync, // BUG FIX: Track local resume time to prevent auto-pause from syncTimerState
            });
            invoke('start_activity_monitoring').catch(e => logger.error('INVOKE', 'start_activity_monitoring failed', e)); // FIX: Sync to RUNNING — start monitoring
            invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
            return;
          }
        } catch (_) {
          // fetch failed — don't assume state, fall through to generic error
        }
      }
      if (entryStoppedOrGone) {
        // BUG FIX: Check Timer Engine state before stopping to avoid "already stopped" warning
        try {
          const timerState = await TimerEngineAPI.getState();
          if (timerState.state !== 'STOPPED') {
            try {
              await TimerEngineAPI.stop();
            } catch (stopError: any) {
              // Ignore "already stopped" errors - this is normal
              if (!stopError?.message?.includes('already stopped')) {
                logger.debug('RESUME', 'Failed to stop Timer Engine (non-critical)', stopError);
              }
            }
          }
        } catch (stateError) {
          // If we can't check state, try to stop anyway
          try {
            await TimerEngineAPI.stop();
          } catch (stopError: any) {
            // Ignore "already stopped" errors - this is normal
            if (!stopError?.message?.includes('already stopped')) {
              logger.debug('RESUME', 'Failed to stop Timer Engine after state check error (non-critical)', stopError);
            }
          }
        }
        try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ }
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          lastResumeTime: null,
          localTimerStartTime: null,
        });
        try { await invoke('hide_idle_window'); } catch (_) { /* ignore */ }
        return;
      }
      set({ error: msg, isLoading: false });
      try {
        await invoke('stop_activity_monitoring');
      } catch (e) {
        // BUG FIX: Log error instead of silently ignoring
        logger.debug('RESUME', 'Failed to stop activity monitoring in error handler (non-critical)', e);
      }
    }
  },

  stopTracking: async () => {
    const { isLoading: currentLoading } = get();
    
    // Prevent multiple simultaneous calls
    if (currentLoading) {
      return;
    }
    
    // BUG FIX: Check actual Timer Engine state instead of store cache
    // Store cache can be stale, Timer Engine is source of truth
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('STOP', 'Failed to get Timer Engine state', error);
      // If we can't get state, use store as fallback
      const { isTracking } = get();
      if (!isTracking) {
        return;
      }
    }
    
    // Engine already stopped — но если есть currentTimeEntry, нужно синхронизировать с сервером
    const isTracking = timerState ? (timerState.state === 'RUNNING' || timerState.state === 'PAUSED') : get().isTracking;
    if (!isTracking) {
      const entry = get().currentTimeEntry;
      if (!entry) {
        set({ isTracking: false, isPaused: false, currentTimeEntry: null });
        return;
      }
      // Движок остановлен, но есть запись — синхронизируем stop с сервером
    }
    
    // BUG FIX: Set isLoading immediately to prevent race condition
    set({ isLoading: true, error: null });
    
    // Double-check after setting isLoading (race condition protection)
    const stateAfterLock = get();
    if (stateAfterLock.isLoading !== true) {
      logger.warn('STOP', 'Race condition detected: state changed between check and set');
      set({ isLoading: false });
      return;
    }
    
    // BUG FIX: Re-check currentTimeEntry after setting isLoading
    // It may have changed between initial check and now
    let timeEntryToStop = get().currentTimeEntry;
    
    // Если нет currentTimeEntry, но таймер работает — пробуем загрузить (как в pauseTracking)
    if (!timeEntryToStop) {
      try {
        await get().loadActiveTimeEntry();
        timeEntryToStop = get().currentTimeEntry;
      } catch (_) {}
      if (!timeEntryToStop) {
        const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
        if (currentUser) {
          try {
            const activeEntries = await api.getActiveTimeEntries();
            const userEntry = activeEntries.find((e) => e.userId === currentUser.id);
            if (userEntry) {
              timeEntryToStop = userEntry;
              logger.debugTerminal('STOP', `entryId from getActiveTimeEntries: ${userEntry.id} userId=${userEntry.userId}`);
            }
          } catch (_) {}
        }
      }
    }

    // Если по-прежнему нет currentTimeEntry — останавливаем движок и enqueue stop (офлайн)
    // SECURITY: НЕ enqueue stop с lastId когда userEntries=0 — lastId может быть из очереди (fallback)
    // и относиться к чужой записи. Останавливаем только движок и очищаем состояние.
    if (!timeEntryToStop) {
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
      let hasUserEntriesOnServer = false;
      if (currentUser) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          hasUserEntriesOnServer = activeEntries.some((e) => e.userId === currentUser.id);
        } catch (_) {}
      }
      // Only use lastId when current user has entries on server — otherwise lastId may be foreign (from queue fallback)
      const lastId = hasUserEntriesOnServer
        ? await invoke<string | null>('get_last_time_entry_id').catch(() => null)
        : null;
      if (!hasUserEntriesOnServer) {
        logger.debugTerminal('STOP', 'no-entry path: hasUserEntriesOnServer=false, skipping enqueue');
      }
      if (lastId && !lastId.startsWith('temp-')) {
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
        const refreshToken = localStorage.getItem('refresh_token');
        await invoke<number>('enqueue_time_entry', {
          operation: 'stop',
          payload: { id: lastId },
          accessToken,
          refreshToken: refreshToken || null,
        }).catch((e) => handleEnqueueError('STOP', e, set));
      }
      try {
        const timerState = await TimerEngineAPI.getState();
        if (timerState.state !== 'STOPPED') {
          await TimerEngineAPI.stop();
        }
        await invoke('stop_activity_monitoring');
        invoke('persist_time_entry_id', { id: null }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          localTimerStartTime: null,
          lastResumeTime: null,
        });
        invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
      } catch (e: any) {
        // BUG FIX: Log error instead of silently ignoring (already logging, but ensure isLoading is reset)
        // Игнорируем ошибку "already stopped" - это нормально
        if (!e?.message?.includes('already stopped')) {
          logger.debug('STOP', 'Failed to stop timer engine (non-critical)', e);
        }
        // BUG FIX: Always reset isLoading even on error
        set({ isLoading: false });
      }
      return;
    }

    try {
      const entryIdToStop = timeEntryToStop.id;
      logger.debugTerminal('STOP', `entryIdToStop=${entryIdToStop} userId=${timeEntryToStop.userId} source=currentTimeEntry`);
      
      // OPTIMISTIC: Сначала Timer Engine (локально), сразу обновляем UI
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        timerState = await TimerEngineAPI.stop();
      } catch (timerError: any) {
        if (timerError.message?.includes('already stopped')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          const msg = timerError?.message ?? '';
          const isSaveError = msg.includes('Failed to save state');
          await invoke('show_notification', {
            title: isSaveError ? 'Storage error' : 'Timer error',
            body: isSaveError ? 'Could not save timer state. Check storage.' : 'Could not stop timer',
          }).catch((e) => {
            logger.warn('STOP', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch(() => null);
        }
      }
      
      const isStopped = timerState?.state === 'STOPPED' || false;
      
      // BUG FIX: Send URL activities BEFORE clearing currentTimeEntry — sendUrlActivities needs it for filtering
      if (isStopped && !entryIdToStop.startsWith('temp-')) {
        try {
          await get().sendUrlActivities();
        } catch (e) {
          logger.warn('STOP', 'Failed to send URL activities', e);
        }
      }
      
      // OPTIMISTIC: Обновляем UI сразу
      invoke('persist_time_entry_id', { id: null }).catch(e => logger.error('INVOKE', 'persist_time_entry_id failed', e));
      set({
        currentTimeEntry: null,
        isTracking: timerState?.state === 'RUNNING' || timerState?.state === 'PAUSED' || false,
        isPaused: timerState?.state === 'PAUSED' || false,
        isLoading: false,
        error: !isStopped ? 'Could not stop timer' : null,
        idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
        localTimerStartTime: null,
        lastResumeTime: null,
        lastTimerStateFromStart: null,
        clientSessionStartMs: null,
      });
      
      invoke('stop_activity_monitoring').catch((e) => {
        logger.warn('STOP', 'Failed to stop activity monitoring', e);
      });
      
      invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
      
      // FIX: Enqueue СРАЗУ (до любых сетевых вызовов), чтобы при офлайне задача попадала в очередь
      let queueIdStop: number | null = null;
      if (isStopped && !entryIdToStop.startsWith('temp-')) {
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token') || '';
        const refreshToken = localStorage.getItem('refresh_token');
        queueIdStop = await invoke<number>('enqueue_time_entry', {
          operation: 'stop',
          payload: { id: entryIdToStop },
          accessToken,
          refreshToken: refreshToken || null,
        }).catch((e) => handleEnqueueError('STOP', e, set));
      }
      // API в фоне (пропускаем если entry с temp id — запись ещё не создана на сервере)
      if (isStopped && !entryIdToStop.startsWith('temp-')) (async () => {
        try {
          const queueId = queueIdStop;
          await api.stopTimeEntry(entryIdToStop);
          await api.sendHeartbeat(false);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(e => logger.error('INVOKE', 'mark_task_sent_by_id failed', e));
          }
        } catch (apiError: any) {
          logger.warn('STOP', 'API failed (background), queue will retry', apiError);
          invoke('show_notification', {
            title: 'Sync',
            body: 'Timer stopped, but could not sync with server',
          }).catch(e => logger.error('INVOKE', 'show_notification failed', e));
        }
      })();
    } catch (error: any) {
      const msg = error.message || 'Failed to stop tracking';
      const alreadyStopped = typeof msg === 'string' && msg.includes('already stopped');
      if (alreadyStopped) {
        // Запись уже остановлена на бэкенде — приводим UI и движок к состоянию «остановлено»
        try {
          await TimerEngineAPI.stop();
        } catch (stopError) {
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('STOP', 'Timer Engine already stopped (non-critical)', stopError);
        }
        try {
          await invoke('stop_activity_monitoring');
        } catch (monitoringError) {
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('STOP', 'Activity monitoring already stopped (non-critical)', monitoringError);
        }
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
          lastResumeTime: null,
          localTimerStartTime: null,
        });
        try {
          await invoke('hide_idle_window');
        } catch (hideError) {
          // BUG FIX: Log error instead of silently ignoring
          logger.debug('STOP', 'Idle window already hidden (non-critical)', hideError);
        }
      } else {
        // Проверяем реальное состояние Timer Engine при ошибке для синхронизации
        try {
          const timerState = await TimerEngineAPI.getState();
          // Синхронизируем состояние с Timer Engine
          set({
            isPaused: timerState.state === 'PAUSED',
            isTracking: timerState.state === 'RUNNING' || timerState.state === 'PAUSED',
            isLoading: false,
            error: msg,
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, idlePauseStartTime: null,
  idlePauseStartPerfRef: null, lastResumeTime: null, localTimerStartTime: null } : {}),
          });
          if (timerState.state === 'STOPPED') {
            invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e)); // FIX: Sync to STOPPED — ensure idle window hidden
          }
        } catch (e) {
          // Если не удалось проверить Timer Engine, только устанавливаем ошибку
          set({ error: msg, isLoading: false });
        }
        try {
          await invoke('stop_activity_monitoring');
        } catch (e) {
          // Ignore
        }
      }
    }
  },

  // updateElapsedTime УДАЛЕН - время теперь считается в Rust Timer Engine

  updateActivityTime: (idleSecs?: number) => {
    // FIX: Don't update lastActivityTime when idle window is shown — user moving mouse
    // in idle window would reset displayed idle time to 0 (Hubstaff shows total idle, not window-open time)
    const { idlePauseStartTime } = get();
    if (idlePauseStartTime !== null && idlePauseStartTime > 0) {
      return;
    }
    const now = Date.now();
    const perfNow = typeof performance !== 'undefined' ? performance.now() : now;
    // If Rust passes idle_secs, lastActivity was actually (now - idleSecs) ago
    const lastActivity = idleSecs != null ? now - idleSecs * 1000 : now;
    const perfRef = idleSecs != null ? perfNow - idleSecs * 1000 : perfNow;
    set({ lastActivityTime: lastActivity, lastActivityPerfRef: perfRef });
    logger.safeLogToRust(`[ACTIVITY] Activity detected, updated time: ${new Date(lastActivity).toLocaleTimeString()}`).catch((e) => {
      logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
    });
  },

  setIdleThreshold: (minutes: number) => {
    const valid = Math.max(1, Math.floor(minutes));
    set({ idleThreshold: valid });
  },

  checkIdleStatus: async () => {
    if (get().isInitializingEntry) return;
    const { lastActivityTime, lastActivityPerfRef, idleThreshold, isLoading, idlePauseStartTime } = get();
    
    // FIX: Skip immediately if already in idle state (idle window shown, user hasn't resumed/stopped)
    // Prevents repeated pause calls every 10s when Timer Engine/store race causes isPaused to be stale
    if (idlePauseStartTime !== null && idlePauseStartTime > 0) {
      logger.safeLogToRust(`[IDLE CHECK] Skipped: already in idle state (idlePauseStartTime set)`).catch((e) => {
        logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
      });
      return;
    }
    
    // BUG FIX: Check actual Timer Engine state instead of relying on store cache
    // Store cache (isTracking) can be stale if updateTimerState was skipped due to isLoading
    let actualTimerState: TimerStateResponse | null = null;
    try {
      actualTimerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('IDLE_CHECK', 'Failed to get Timer Engine state', error);
      return; // Can't check idle if we can't get timer state
    }
    
    const isTracking = actualTimerState.state === 'RUNNING';
    const isPaused = actualTimerState.state === 'PAUSED';
    
    // Don't check if not tracking, paused, or already loading (to prevent multiple pauses)
    if (!isTracking || isPaused || isLoading) {
      logger.safeLogToRust(`[IDLE CHECK] Skipped: isTracking=${isTracking}, isPaused=${isPaused}, isLoading=${isLoading}, timerState=${actualTimerState.state}`).catch((e) => {
        logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
      });
      return;
    }

    // performance.now() — монотонно, не прыгает при NTP (Hubstaff-style)
    const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const timeDiff = perfNow - lastActivityPerfRef;
    const idleTime = isNaN(timeDiff) ? 0 : Math.max(0, timeDiff) / 1000 / 60; // minutes
    const effectiveThreshold = Math.max(1, idleThreshold); // Guard: never pause on threshold <= 0

    await logger.safeLogToRust(`[IDLE CHECK] Idle time: ${idleTime.toFixed(2)} min, threshold: ${effectiveThreshold} min, lastActivity: ${new Date(lastActivityTime).toLocaleTimeString()}`);
    
    if (idleTime >= effectiveThreshold) {
      await logger.safeLogToRust(`[IDLE CHECK] Threshold exceeded! Pausing tracker...`);
      
      // BUG FIX: Double-check Timer Engine state before pausing (race condition protection)
      // Don't use store cache here - it can be stale. Check Timer Engine directly.
      try {
        const timerState = await TimerEngineAPI.getState();
        // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
        if (timerState.state === 'PAUSED' || timerState.state === 'STOPPED') {
          await logger.safeLogToRust(`[IDLE CHECK] Timer Engine already ${timerState.state}, updating local state and skipping pause`).catch((e) => {
            logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
          });
          const currentTimerState = timerState.state;
          // BUG FIX: isTracking should be true if PAUSED (timer is active, just paused), false if STOPPED
          set({
            isPaused: currentTimerState === 'PAUSED',
            isTracking: currentTimerState === 'PAUSED', // true if PAUSED (timer is active, just paused)
            idlePauseStartTime: null,
  idlePauseStartPerfRef: null, // FIX: Syncing to Timer Engine — not idle (store had stale RUNNING)
            ...(currentTimerState === 'STOPPED'
              ? { currentTimeEntry: null, lastResumeTime: null, localTimerStartTime: null }
              : {}),
          });
          invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e)); // FIX: Ensure idle window hidden when syncing
          return;
        }
        // Если Timer Engine RUNNING, продолжаем с паузой
        // BUG FIX: Also check isLoading from store to prevent race conditions
        const currentStoreState = get();
        if (currentStoreState.isLoading) {
          await logger.safeLogToRust(`[IDLE CHECK] Operation in progress, skipping pause`).catch((e) => {
            logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
          });
          return;
        }
      } catch (timerError) {
        // Если не удалось получить состояние, НЕ ставим на паузу автоматически
        // Это может быть ошибка сети или другая проблема
        logger.warn('IDLE_CHECK', 'Failed to get timer state, ABORTING pause to prevent false pause', timerError);
        await logger.safeLogToRust(`[IDLE CHECK] Failed to get timer state, ABORTING pause to prevent false pause: ${timerError}`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        return; // НЕ продолжаем с паузой, если не можем проверить состояние
      }
      
      // BUG FIX: Do NOT skip based on currentTimeEntry.status === 'PAUSED'.
      // Timer Engine is RUNNING (verified above) — we must pause and show idle window.
      // Store's currentTimeEntry can be stale (e.g. from sync/loadActiveTimeEntry).
      // Skipping here caused idle window to never appear when user waited 2 min.
      
      // Don't set isLoading here - let pauseTracking manage it
      // This prevents the "Already loading" check from blocking the pause
      
      // FIX: Re-check idlePauseStartTime before pause — concurrent checkIdleStatus may have completed
      if (get().idlePauseStartTime !== null) {
        await logger.safeLogToRust(`[IDLE CHECK] Skipped: another pause already in progress (idlePauseStartTime set)`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        return;
      }
      
      // FIX: Mutex — only one pause flow at a time (prevents overlapping intervals / React Strict Mode)
      if (isIdleCheckPausing) {
        await logger.safeLogToRust(`[IDLE CHECK] Skipped: pause already in progress (mutex)`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        return;
      }
      isIdleCheckPausing = true;
      
      try {
        // Get pauseTracking function directly from store
        const pauseFn = get().pauseTracking;
        await logger.safeLogToRust(`[IDLE CHECK] Calling pauseTracking function...`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        // Auto pause - pass isIdlePause=true so pauseTracking sets idlePauseStartTime
        await pauseFn(true);
        
        // Wait a bit for state to update
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify pause was successful
        const stateAfterPause = get();
        await logger.safeLogToRust(`[IDLE CHECK] After pause: isTracking=${stateAfterPause.isTracking}, isPaused=${stateAfterPause.isPaused}, isLoading=${stateAfterPause.isLoading}, idlePauseStartTime=${stateAfterPause.idlePauseStartTime}`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        
        // Only show idle window if pause was successful AND idlePauseStartTime is set
        if (stateAfterPause.isPaused && stateAfterPause.idlePauseStartTime) {
          await logger.safeLogToRust(`[IDLE CHECK] Tracker paused successfully with idle pause start time`).catch((e) => {
            logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
          });
          
          const pauseStartTime = stateAfterPause.idlePauseStartTime;
          
          // Show notification FIRST so it appears above IdleWindow (alwaysOnTop can overlay notifications)
          await invoke('show_notification', {
            title: 'Tracker paused',
            body: `No activity for more than ${idleThreshold} minutes`,
          });
          
          // Show idle window and send initial state
          try {
            await invoke('show_idle_window');
            await logger.safeLogToRust(`[IDLE CHECK] Idle window shown, waiting for React to initialize...`).catch((e) => {
              logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
            });
            
            // Wait longer for React component to mount and set up listeners
            // React needs time to render and set up event listeners
            // Increased delay to ensure listener is ready
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            await logger.safeLogToRust(`[IDLE CHECK] Sending state update with pauseStartTime: ${pauseStartTime} (type: ${typeof pauseStartTime})`).catch((e) => {
              logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
            });
            
            // Send initial state to idle window
            // FIX: Убеждаемся, что передаем правильный тип (u64 для Rust)
            // Rust Option<u64> принимает null как None
            const pauseTimeForRust = pauseStartTime && pauseStartTime > 0 ? Number(pauseStartTime) : null;
            await logger.safeLogToRust(`[IDLE CHECK] Calling update_idle_state with pauseTime: ${pauseTimeForRust} (type: ${typeof pauseTimeForRust})`).catch((e) => {
              logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
            });
            
            const lastActivityForRust = stateAfterPause.lastActivityTime && stateAfterPause.lastActivityTime > 0 ? Number(stateAfterPause.lastActivityTime) : null;
            const lastActivityPerfRefForRust = stateAfterPause.lastActivityPerfRef ?? null;
            const idlePauseStartPerfRefForRust = stateAfterPause.idlePauseStartPerfRef ?? null;
            const projectName = stateAfterPause.selectedProject?.name || stateAfterPause.currentTimeEntry?.project?.name || null;
            invoke('update_idle_state', {
              idlePauseStartTime: pauseTimeForRust,
              idlePauseStartPerfRef: idlePauseStartPerfRefForRust,
              isLoading: false,
              lastActivityTime: lastActivityForRust,
              lastActivityPerfRef: lastActivityPerfRefForRust,
              projectName,
            }).catch(async (err) => {
              logger.warn('IDLE_CHECK', 'Failed to send state update to idle window', err);
              await logger.safeLogToRust(`[IDLE CHECK] Failed to send state update: ${err}`).catch((e) => {
                logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
              });
            });
            
            await logger.safeLogToRust(`[IDLE CHECK] State updates sent successfully`).catch((e) => {
              logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
            });
          } catch (error) {
            logger.error('IDLE_CHECK', 'Failed to show idle window', error);
            await logger.safeLogToRust(`[IDLE CHECK] Failed to show idle window: ${error}`).catch((e) => {
              logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
            });
          }
        } else {
          // isPaused but idlePauseStartTime was null (race with Timer's updateTimerState clearing it)
          await logger.safeLogToRust(`[IDLE CHECK] Paused but idlePauseStartTime was null, syncing and showing idle window`).catch((e) => {
            logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
          });
          try {
            const timerState = await TimerEngineAPI.getState();
            if (timerState.state === 'PAUSED') {
              const pauseStartTime = Date.now();
              const pausePerfRef = typeof performance !== 'undefined' ? performance.now() : Date.now();
              const storeState = get();
              set({
                isPaused: true,
                isTracking: true,
                idlePauseStartTime: pauseStartTime,
                idlePauseStartPerfRef: pausePerfRef,
              });
              await invoke('show_notification', {
                title: 'Tracker paused',
                body: `No activity for more than ${idleThreshold} minutes`,
              }).catch(() => {});
              await invoke('show_idle_window');
              await new Promise(resolve => setTimeout(resolve, 1000));
              const lastActivityForRust = storeState.lastActivityTime && storeState.lastActivityTime > 0 ? Number(storeState.lastActivityTime) : null;
              const lastActivityPerfRefForRust = storeState.lastActivityPerfRef ?? null;
              const projectName = get().selectedProject?.name || get().currentTimeEntry?.project?.name || null;
              invoke('update_idle_state', {
                idlePauseStartTime: pauseStartTime,
                idlePauseStartPerfRef: pausePerfRef,
                isLoading: false,
                lastActivityTime: lastActivityForRust,
                lastActivityPerfRef: lastActivityPerfRefForRust,
                projectName,
              }).catch(() => {});
            } else if (timerState.state === 'STOPPED') {
              set({
                isPaused: false,
                isTracking: false,
                currentTimeEntry: null,
                idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
                lastResumeTime: null,
                localTimerStartTime: null,
              });
            } else {
              set({ isPaused: false, idlePauseStartTime: null,
  idlePauseStartPerfRef: null, lastResumeTime: Date.now() });
            }
          } catch (e) {
            set({ isPaused: false, idlePauseStartTime: null, idlePauseStartPerfRef: null });
          }
        }
      } catch (error: any) {
        logger.error('IDLE_CHECK', 'Error pausing tracker', error);
        await logger.safeLogToRust(`[IDLE CHECK] Error pausing: ${error.message || 'Unknown error'}`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        // Проверяем реальное состояние Timer Engine перед очисткой
        try {
          const timerState = await TimerEngineAPI.getState();
          if (timerState.state === 'PAUSED' || timerState.state === 'STOPPED') {
            // Timer Engine на паузе/остановлен — синхронизируем состояние
            set({
              isPaused: timerState.state === 'PAUSED',
              isTracking: timerState.state === 'PAUSED', // timerState.state can only be 'PAUSED' or 'STOPPED' here
              idlePauseStartTime: timerState.state === 'PAUSED' ? Date.now() : null,
              ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, lastResumeTime: null, localTimerStartTime: null } : {}),
            });
          } else {
            // Timer Engine не на паузе — очищаем состояние
            set({ isPaused: false, idlePauseStartTime: null });
          }
        } catch (e) {
          // Если не удалось проверить Timer Engine, очищаем состояние
          set({ isPaused: false, idlePauseStartTime: null });
        }
      } finally {
        isIdleCheckPausing = false;
      }
    }
  },

  addUrlActivity: (activity: UrlActivity) => {
    const { urlActivities, currentTimeEntry } = get();
    
    // Only add if we have an active time entry
    if (!currentTimeEntry) {
      return;
    }
    
    // Validate activity
    if (!activity.url || !activity.domain || activity.timeSpent <= 0) {
      logger.warn('URL_ACTIVITY', 'Invalid URL activity', activity);
      return;
    }
    
    // Ensure timeEntryId matches current entry
    const activityWithEntryId: UrlActivity = {
      ...activity,
      timeEntryId: currentTimeEntry.id,
    };
    
    set({ urlActivities: [...urlActivities, activityWithEntryId] });
    
    // Log for debugging
    logger.safeLogToRust(`[URL ACTIVITY] Added: ${activity.domain} (${activity.timeSpent}s), total: ${urlActivities.length + 1}`).catch((e) => {
      logger.debug('URL_ACTIVITY', 'Failed to log (non-critical)', e);
    });
  },

  sendUrlActivities: async () => {
    // Race condition protection: prevent multiple simultaneous sends
    const currentState = get();
    if (currentState.isLoading) {
      // Another operation is in progress, skip this send
      return;
    }
    
    const { urlActivities, currentTimeEntry } = currentState;
    
    // Don't send if no activities or no active time entry
    if (urlActivities.length === 0 || !currentTimeEntry) {
      return;
    }
    
    // BUG FIX: Check actual Timer Engine state instead of store cache
    // Store cache can be stale, Timer Engine is source of truth
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('SEND_URL_ACTIVITIES', 'Failed to get Timer Engine state', error);
      // If we can't get state, use store as fallback
      if (currentState.isPaused) {
        return;
      }
    }
    
    // Don't send if tracking is paused
    const isPaused = timerState ? timerState.state === 'PAUSED' : currentState.isPaused;
    if (isPaused) {
      return;
    }
    
    // Filter out activities that don't match current time entry (from previous day/session)
    const today = new Date().toDateString();
    const entryDate = new Date(currentTimeEntry.startTime).toDateString();
    const validActivities = entryDate === today 
      ? urlActivities.filter(a => a.timeEntryId === currentTimeEntry.id)
      : []; // If entry is from previous day, don't send old activities
    
    if (validActivities.length === 0) {
      // Clear invalid activities
      if (urlActivities.length > 0) {
        set({ urlActivities: [] });
      }
      return;
    }
    
    try {
      // Split into batches of 100 (API limit)
      const batchSize = 100;
      const batches: UrlActivity[][] = [];
      
      for (let i = 0; i < validActivities.length; i += batchSize) {
        batches.push(validActivities.slice(i, i + batchSize));
      }
      
      // Save count before clearing
      const activitiesCount = validActivities.length;
      
      // Send each batch
      for (const batch of batches) {
        await logger.safeLogToRust(`[URL ACTIVITY] Sending batch of ${batch.length} activities...`).catch((e) => {
          logger.debug('URL_ACTIVITY', 'Failed to log (non-critical)', e);
        });
        
        const response = await api.batchUploadUrlActivities({ activities: batch });
        
        await logger.safeLogToRust(`[URL ACTIVITY] Batch sent: ${response.count} created, ${response.skipped} skipped`).catch((e) => {
          logger.debug('URL_ACTIVITY', 'Failed to log (non-critical)', e);
        });
      }
      
      // Clear sent activities (only the ones we sent)
      const remainingActivities = urlActivities.filter(a => 
        !validActivities.some(va => 
          va.timeEntryId === a.timeEntryId && 
          va.url === a.url && 
          va.domain === a.domain &&
          Math.abs(va.timeSpent - a.timeSpent) < 1 // Same activity (within 1 second tolerance)
        )
      );
      
      set({ urlActivities: remainingActivities });
      
      await logger.safeLogToRust(`[URL ACTIVITY] All batches sent successfully, cleared ${activitiesCount} activities`).catch((e) => {
        logger.debug('URL_ACTIVITY', 'Failed to log (non-critical)', e);
      });
    } catch (error: any) {
      // Log error but don't clear activities - they will be retried next time
      logger.error('URL_ACTIVITY', 'Failed to send URL activities', error);
      await logger.safeLogToRust(`[URL ACTIVITY] Failed to send: ${error.message || 'Unknown error'}`).catch((e) => {
        logger.debug('URL_ACTIVITY', 'Failed to log (non-critical)', e);
      });
    }
  },

  reset: async () => {
    try {
      await TimerEngineAPI.stop();
    } catch (_) {
      // ignore
    }
    try {
      await invoke('stop_activity_monitoring');
    } catch (e) {
      // Ignore errors
    }
    try {
      await invoke('hide_idle_window');
    } catch (_) {
      // ignore
    }
    // Очистка localStorage больше не нужна - время хранится в Rust Timer Engine
    // Reset all state
    set({
      projects: [],
      selectedProject: null,
      currentTimeEntry: null,
      isTracking: false,
      isPaused: false,
      lastActivityTime: Date.now(),
      lastActivityPerfRef: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      isLoading: false,
      error: null,
      idlePauseStartTime: null,
      idlePauseStartPerfRef: null,
      urlActivities: [],
      localTimerStartTime: null,
      lastResumeTime: null,
      lastTimerStateFromStart: null,
      clientSessionStartMs: null,
    });
  },

  saveTimerState: async () => {
    try {
      await TimerEngineAPI.saveState();
    } catch (e) {
      logger.error('STORE', 'Failed to save timer state (backend)', e);
      throw e;
    }
  },
  getTimerState: async () => TimerEngineAPI.getState(),
  sendHeartbeat: async (active: boolean) => {
    await api.sendHeartbeat(active);
  },
  uploadScreenshot: async (file: File, timeEntryId: string) => {
    await api.uploadScreenshot(file, timeEntryId);
  },
  getAccessToken: () => api.getAccessToken(),
  getScreenshots: async (timeEntryId: string) => api.getScreenshots(timeEntryId),
  resetDay: async () => {
    await TimerEngineAPI.resetDay();
    const state = await TimerEngineAPI.getState();
    set({
      isTracking: state.state === 'RUNNING' || state.state === 'PAUSED',
      isPaused: state.state === 'PAUSED',
      ...(state.state === 'STOPPED'
        ? { currentTimeEntry: null, idlePauseStartTime: null,
  idlePauseStartPerfRef: null, lastResumeTime: null, localTimerStartTime: null }
        : {}),
    });
    if (state.state === 'STOPPED') {
      invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e)); // FIX: Idle window visible when day changed
    }
    return state;
  },

  clearTrackingStateFromServer: async () => {
    // BUG FIX: Check Timer Engine state before stopping to avoid "already stopped" warning
    try {
      const timerState = await TimerEngineAPI.getState();
      // Only stop if Timer Engine is not already STOPPED
      if (timerState.state !== 'STOPPED') {
        try {
          await TimerEngineAPI.stop();
        } catch (stopError: any) {
          // Ignore "already stopped" errors - this is normal
          if (!stopError?.message?.includes('already stopped')) {
            logger.debug('CLEAR', 'Failed to stop Timer Engine (non-critical)', stopError);
          }
        }
      }
    } catch (stateError) {
      // If we can't check state, try to stop anyway (better to try than skip)
      try {
        await TimerEngineAPI.stop();
      } catch (stopError: any) {
        // Ignore "already stopped" errors - this is normal
        if (!stopError?.message?.includes('already stopped')) {
          logger.debug('CLEAR', 'Failed to stop Timer Engine after state check error (non-critical)', stopError);
        }
      }
    }
    try {
      await invoke('stop_activity_monitoring');
    } catch (_) {
      // ignore
    }
    set({
      currentTimeEntry: null,
      isTracking: false,
      isPaused: false,
      isLoading: false,
      error: null,
      idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
      localTimerStartTime: null, // Clear local timer start time
      lastResumeTime: null, // Clear resume time on stop
      lastTimerStateFromStart: null,
      clientSessionStartMs: null,
    });
    try {
      await invoke('hide_idle_window');
    } catch (_) {
      // ignore
    }
  },

  assertStateInvariant: async () => {
    // Проверка инвариантов состояния: Store должен быть синхронизирован с Timer Engine
    // Эта функция вызывается периодически для обнаружения и исправления рассинхронизации
    
    try {
      const storeState = get();
      
      // Не проверяем инварианты во время операций (isLoading = true)
      // Это предотвращает ложные срабатывания во время переходов состояния
      if (storeState.isLoading) {
        assertStateInvariantSkippedDueToLoading++;
        if (assertStateInvariantSkippedDueToLoading >= ASSERT_STATE_INVARIANT_LOADING_STUCK_THRESHOLD) {
          logger.warn('STATE_INVARIANT', 'isLoading stuck for 60s, forcing recovery');
          set({ isLoading: false });
          assertStateInvariantSkippedDueToLoading = 0;
          // Fall through to run invariant check
        } else {
          return;
        }
      } else {
        assertStateInvariantSkippedDueToLoading = 0;
      }
      
      // Получаем состояние Timer Engine (источник истины)
      const timerState = await TimerEngineAPI.getState();
      
      // Инвариант 1: isTracking должен соответствовать Timer Engine
      // isTracking = true если Timer Engine в состоянии RUNNING или PAUSED
      const expectedTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
      const isTrackingDesync = storeState.isTracking !== expectedTracking;
      
      // Инвариант 2: isPaused должен соответствовать Timer Engine
      // isPaused = true только если Timer Engine в состоянии PAUSED
      const expectedPaused = timerState.state === 'PAUSED';
      const isPausedDesync = storeState.isPaused !== expectedPaused;
      
      // Если обнаружена рассинхронизация, логируем и исправляем
      if (isTrackingDesync || isPausedDesync) {
        // BUG FIX: Timer Engine RUNNING/PAUSED но currentTimeEntry === null — пробуем загрузить с сервера
        if ((timerState.state === 'RUNNING' || timerState.state === 'PAUSED') && !storeState.currentTimeEntry) {
          logger.debug('STATE_INVARIANT', 'Timer Engine is active but currentTimeEntry is null - attempting loadActiveTimeEntry');
          try {
            await get().loadActiveTimeEntry();
          } catch (e) {
            logger.warn('STATE_INVARIANT', 'loadActiveTimeEntry failed during invariant check', e);
          }
          // Если loadActiveTimeEntry не восстановил entry (например PAUSED после wake), синхронизируем только store
          const stateAfterLoad = get();
          if (!stateAfterLoad.currentTimeEntry && timerState.state === 'PAUSED') {
            set({
              isTracking: expectedTracking,
              isPaused: expectedPaused,
              idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
            });
            invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e));
          }
          return;
        }
        
        logger.debugTerminal('INVARIANT', `desync: store isTracking=${storeState.isTracking} isPaused=${storeState.isPaused} engine=${timerState.state}`);
        logger.warn('STATE_INVARIANT', 'State desync detected, auto-syncing', {
          store: { isTracking: storeState.isTracking, isPaused: storeState.isPaused, hasEntry: !!storeState.currentTimeEntry, idlePauseStartTime: storeState.idlePauseStartTime },
          timerEngine: { state: timerState.state, expectedTracking, expectedPaused },
        });
        
        // Отправляем в Sentry для мониторинга (если доступно)
        try {
          const { captureMessage, setSentryContext } = await import('../lib/sentry');
          setSentryContext('state_desync', {
            storeState: {
              isTracking: storeState.isTracking,
              isPaused: storeState.isPaused,
            },
            timerEngineState: timerState.state,
          });
          captureMessage('State desync detected and auto-fixed', 'warning');
        } catch (e) {
          // Sentry может быть недоступен в dev режиме
          logger.debug('STATE_INVARIANT', 'Sentry not available', e);
        }
        
        // Автоматически синхронизируем состояние с Timer Engine
        set({
          isTracking: expectedTracking,
          isPaused: expectedPaused,
          ...(timerState.state === 'STOPPED'
            ? {
                currentTimeEntry: null,
                idlePauseStartTime: null,
  idlePauseStartPerfRef: null,
                lastResumeTime: null,
                localTimerStartTime: null,
              }
            : timerState.state === 'RUNNING'
              ? { idlePauseStartTime: null } // FIX: Clear idle — Timer Engine RUNNING means we're not idle
              : {}),
        });
        
        await logger.safeLogToRust(`[INVARIANT] fixed: isTracking=${expectedTracking} isPaused=${expectedPaused} (was store=${storeState.isTracking}/${storeState.isPaused} engine=${timerState.state})`).catch((e) => {
          logger.debug('STATE_INVARIANT', 'Failed to log (non-critical)', e);
        });
        if (timerState.state === 'RUNNING' || timerState.state === 'STOPPED') {
          invoke('hide_idle_window').catch(e => logger.error('INVOKE', 'hide_idle_window failed', e)); // FIX: Idle window must be hidden when not in idle
        }
        if (timerState.state === 'RUNNING') {
          invoke('start_activity_monitoring').catch(e => logger.error('INVOKE', 'start_activity_monitoring failed', e)); // FIX: Sync to RUNNING — ensure monitoring
        }
      }
    } catch (error) {
      // Если не удалось проверить инварианты (например, Timer Engine недоступен),
      // логируем ошибку, но не паникуем
      logger.warn('STATE_INVARIANT', 'Failed to check state invariants', error);
    }
  },
}));

export type { TimerStateResponse } from '../lib/timer-engine';
export type { Screenshot } from '../lib/api';

