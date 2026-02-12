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

// BUG FIX: Tracks consecutive skips of assertStateInvariant due to isLoading — prevents permanent block if isLoading gets stuck
let assertStateInvariantSkippedDueToLoading = 0;
const ASSERT_STATE_INVARIANT_LOADING_STUCK_THRESHOLD = 12; // 12 * 5s = 60s

export interface TrackerState {
  projects: Project[];
  selectedProject: Project | null;
  currentTimeEntry: TimeEntry | null;
  isTracking: boolean; // UI cache - источник истины в Rust Timer Engine
  isPaused: boolean; // UI cache - источник истины в Rust Timer Engine
  lastActivityTime: number;
  idleThreshold: number; // in minutes, default 2
  isLoading: boolean;
  error: string | null;
  isTakingScreenshot: boolean; // Indicates if screenshot is being taken
  idlePauseStartTime: number | null; // Timestamp when paused due to inactivity
  urlActivities: UrlActivity[]; // Accumulated URL activities waiting to be sent
  localTimerStartTime: number | null; // Timestamp when timer was started locally (for sync protection)
  lastResumeTime: number | null; // Timestamp when timer was last resumed (for sync protection)

  // Actions
  loadProjects: () => Promise<void>;
  loadActiveTimeEntry: () => Promise<void>;
  selectProject: (project: Project) => Promise<void>;
  startTracking: (description?: string) => Promise<void>;
  pauseTracking: (isIdlePause?: boolean) => Promise<void>;
  resumeTracking: (fromIdleWindow?: boolean) => Promise<void>;
  stopTracking: () => Promise<void>;
  updateActivityTime: () => void;
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
}

export const useTrackerStore = create<TrackerState>((set, get) => ({
  projects: [],
  selectedProject: null,
  currentTimeEntry: null,
  isTracking: false, // UI cache - синхронизируется с Rust Timer Engine
  isPaused: false, // UI cache - синхронизируется с Rust Timer Engine
  lastActivityTime: Date.now(),
  idleThreshold: 2,
  isLoading: false,
  error: null,
  isTakingScreenshot: false,
  idlePauseStartTime: null,
  urlActivities: [], // Accumulated URL activities
  localTimerStartTime: null, // Track when timer was started locally
  lastResumeTime: null, // Track when timer was last resumed (for sync protection)

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
    try {
      // SECURITY: Get current user first to verify ownership
      // FIX: Fallback to useAuthStore.user — getCurrentUser() can be null on app reload
      // because it's set asynchronously in restoreTokens, which runs in parallel with loadActiveTimeEntry
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
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
      
      if (foreignEntries.length > 0) {
        logger.error('LOAD', `SECURITY: Found ${foreignEntries.length} active time entries belonging to other users. Current user: ${currentUser.id}, Foreign entries: ${foreignEntries.map(e => `${e.id} (user: ${e.userId})`).join(', ')}`);
      }

      if (userEntries.length === 0) {
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
          logger.warn('LOAD', `Multiple active time entries found (${userEntries.length}), resolving duplicates...`);
          
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
                // Останавливаем дубликаты, которые еще работают
                await api.stopTimeEntry(duplicate.id);
                logger.info('LOAD', `Stopped duplicate time entry: ${duplicate.id}`);
              } else if (duplicate.status === 'PAUSED') {
                // Если на паузе, тоже останавливаем для консистентности
                await api.stopTimeEntry(duplicate.id);
                logger.info('LOAD', `Stopped duplicate paused entry: ${duplicate.id}`);
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
          lastActivityTime: Date.now(),
          selectedProject: restoredProject,
          idlePauseStartTime: null, // FIX: Restoring from server — not idle state
        });
      }
    } catch (error: any) {
      // BUG FIX: Log error instead of silently failing
      // Silent failures hide important issues like network errors or API changes
      logger.error('LOAD', 'Failed to load active time entry', error);
      // Don't clear state on error - might be temporary network issue
      // User can retry or sync will happen on next poll
    }
  },

  selectProject: async (project: Project) => {
    const { currentTimeEntry } = get();
    // BUG FIX: Check actual Timer Engine state instead of store cache
    let timerState: TimerStateResponse | null = null;
    try {
      timerState = await TimerEngineAPI.getState();
    } catch (error) {
      logger.warn('SELECT_PROJECT', 'Failed to get Timer Engine state', error);
      // If we can't get state, use store as fallback (better than nothing)
      const { isTracking } = get();
      if (isTracking && currentTimeEntry) {
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
    const isTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
    if (isTracking && currentTimeEntry) {
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

  startTracking: async (description?: string) => {
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

    try {
      // Check for active time entries first
      const activeEntries = await api.getActiveTimeEntries();
      
      // SECURITY: Filter out entries that don't belong to current user
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
      if (currentUser) {
        const userEntries = activeEntries.filter(entry => entry.userId === currentUser.id);
        const foreignEntries = activeEntries.filter(entry => entry.userId !== currentUser.id);
        
        if (foreignEntries.length > 0) {
          logger.error('START', `SECURITY: Found ${foreignEntries.length} active time entries belonging to other users. Current user: ${currentUser.id}, Foreign entries: ${foreignEntries.map(e => `${e.id} (user: ${e.userId})`).join(', ')}`);
        }
        
        // Use only user's entries
        if (userEntries.length > 0) {
          activeEntries.length = 0;
          activeEntries.push(...userEntries);
        }
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
            lastActivityTime: Date.now(),
            selectedProject: restoredProject,
            isLoading: false,
            error: null,
            idlePauseStartTime: null, // FIX: Restoring from server — not idle
          });
          
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
            idlePauseStartTime: null, // FIX: Restoring from server — not idle
          });
          
          return; // Exit - don't create new entry
        } else {
          // Other status - stop it first
          await api.stopTimeEntry(activeEntry.id);
          // Continue to create new entry
        }
      }
      
      // Prepare request data - ensure description is provided
      const requestData: { projectId: string; userId: string; description?: string } = {
        projectId: selectedProject.id,
        userId: user.id,
      };
      
      // Add description if provided, otherwise use empty string or project name
      if (description) {
        requestData.description = description;
      } else {
        requestData.description = `Work on project ${selectedProject.name}`;
      }
      
      // OPTIMISTIC: Сначала Timer Engine (локально), сразу обновляем UI
      const now = Date.now();
      const nowStr = new Date(now).toISOString();
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
      
      let timerState: TimerStateResponse | null = null;
      try {
        const currentTimerState = await TimerEngineAPI.getState();
        if (currentTimerState.state === 'STOPPED') {
          timerState = await TimerEngineAPI.start();
        } else if (currentTimerState.state === 'PAUSED') {
          timerState = await TimerEngineAPI.resume();
        } else if (currentTimerState.state === 'RUNNING') {
          timerState = currentTimerState;
        } else {
          timerState = await TimerEngineAPI.start();
        }
      } catch (timerError: any) {
        if (timerError.message?.includes('already running') || 
            timerError.message?.includes('already paused')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          await invoke('show_notification', {
            title: 'Timer error',
            body: 'Could not start timer',
          }).catch((e) => {
            logger.warn('START', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch((e) => {
            logger.logError('START:getState_fallback', e);
            return null;
          });
        }
      }
      
      const isStarted = timerState?.state === 'RUNNING' || timerState?.state === 'PAUSED' || false;
      
      // OPTIMISTIC: Обновляем UI сразу
      set({
        currentTimeEntry: optimisticEntry,
        isTracking: isStarted,
        isPaused: timerState?.state === 'PAUSED' || false,
        lastActivityTime: now,
        isLoading: false,
        error: !isStarted ? 'Could not start timer' : null,
        localTimerStartTime: isStarted ? now : null,
        idlePauseStartTime: null, // FIX: Starting — not idle
      });
      
      invoke('start_activity_monitoring').catch((e) => {
        logger.error('START', 'Failed to start activity monitoring', e);
      });
      
      // API в фоне
      if (isStarted) (async () => {
        try {
          const accessToken = api.getAccessToken();
          const refreshToken = localStorage.getItem('refresh_token');
          let queueId: number | null = null;
          if (accessToken) {
            queueId = await invoke<number>('enqueue_time_entry', {
              operation: 'start',
              payload: requestData,
              accessToken: accessToken,
              refreshToken: refreshToken || null,
            }).catch((e) => {
              logger.warn('START', 'Failed to enqueue (background)', e);
              return null;
            });
          }
          const timeEntry = await api.startTimeEntry(requestData);
          await api.sendHeartbeat(true);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
          }
          const state = get();
          if (state.isTracking && state.currentTimeEntry?.id?.startsWith('temp-')) {
            set({
              currentTimeEntry: timeEntry,
              localTimerStartTime: null,
            });
          }
        } catch (apiError: any) {
          if (apiError.message?.includes('already running') || 
              apiError.message?.includes('User already has')) {
            try {
              const activeEntries = await api.getActiveTimeEntries();
              const userEntries = activeEntries.filter(e => e.userId === user.id);
              const activeEntry = userEntries[0] ?? activeEntries[0];
              if (activeEntry) {
                set({
                  currentTimeEntry: activeEntry,
                  localTimerStartTime: null,
                  error: null,
                  idlePauseStartTime: null, // FIX: Syncing to existing entry — not idle
                  lastActivityTime: Date.now(), // FIX: Prevent immediate idle after sync
                });
                return;
              }
            } catch (_) {}
          }
          logger.warn('START', 'API failed (background), queue will retry', apiError);
          try {
            await TimerEngineAPI.stop();
          } catch (_) {}
          set({
            currentTimeEntry: null,
            isTracking: false,
            isPaused: false,
            localTimerStartTime: null,
            lastResumeTime: null,
            idlePauseStartTime: null,
            error: 'Could not create entry (will sync later)',
          });
          invoke('hide_idle_window').catch(() => {}); // FIX: Ensure idle window hidden on API failure
          invoke('show_notification', {
            title: 'Sync',
            body: 'Timer started, but could not sync with server',
          }).catch(() => {});
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
          const activeEntries = await api.getActiveTimeEntries();
          if (activeEntries.length > 0) {
            // BUG FIX: Ensure array is not empty before accessing
            const activeEntry = activeEntries[0];
            if (!activeEntry) {
              logger.error('START', 'activeEntries[0] is undefined, this should not happen');
              set({ error: 'Invalid active entries data', isLoading: false });
              return;
            }
            const timerState = await TimerEngineAPI.getState();
            set({
              currentTimeEntry: activeEntry,
              isTracking: timerState.state === 'RUNNING' || timerState.state === 'PAUSED',
              isPaused: timerState.state === 'PAUSED',
              isLoading: false,
              error: null,
              idlePauseStartTime: null, // FIX: Syncing to existing entry — not idle
              lastActivityTime: Date.now(), // FIX: Prevent immediate idle after sync
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
        invoke('hide_idle_window').catch(() => {});
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
              const accessToken = api.getAccessToken();
              const refreshToken = localStorage.getItem('refresh_token');
              let queueId: number | null = null;
              if (accessToken) {
                queueId = await invoke<number>('enqueue_time_entry', {
                  operation: 'stop',
                  payload: { id: entry.id },
                  accessToken,
                  refreshToken: refreshToken || null,
                }).catch((e) => { logger.warn('PAUSE', 'Failed to enqueue stop (engine STOPPED)', e); return null; });
              }
              await api.stopTimeEntry(entry.id);
              await api.sendHeartbeat(false);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
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
          lastResumeTime: null,
          localTimerStartTime: null,
        });
        invoke('hide_idle_window').catch(() => {}); // FIX: Idle window must be hidden when STOPPED
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
      if (currentUser) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          const userEntries = activeEntries.filter((e) => e.userId === currentUser.id);
          const runningEntry = userEntries.find((e) => e.status === 'RUNNING');
          if (runningEntry) {
            logger.info('PAUSE', `Found RUNNING entry on server (${runningEntry.id}), syncing pause`);
            await TimerEngineAPI.pause();
            const accessToken = api.getAccessToken() || localStorage.getItem('access_token');
            const refreshToken = localStorage.getItem('refresh_token');
            let queueId: number | null = null;
            if (accessToken) {
              queueId = await invoke<number>('enqueue_time_entry', {
                operation: 'pause',
                payload: { id: runningEntry.id },
                accessToken,
                refreshToken: refreshToken || null,
              }).catch((e) => { logger.warn('PAUSE', 'Failed to enqueue pause', e); return null; });
            }
            try {
              await api.pauseTimeEntry(runningEntry.id);
              await api.sendHeartbeat(false);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
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
            });
            await invoke('stop_activity_monitoring').catch(() => {});
            return;
          }
        } catch (fetchErr) {
          logger.warn('PAUSE', 'Failed to fetch active entries for pause sync', fetchErr);
        }
      }
      logger.info('PAUSE', 'Pausing Timer Engine without time entry (no RUNNING entry on server)');
      try {
        await TimerEngineAPI.pause();
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
          set({
            isPaused: true,
            isTracking: true,
            isLoading: false,
            error: null,
            idlePauseStartTime: isIdlePause ? Date.now() : null,
            ...(entryForStop ? { currentTimeEntry: entryForStop } : {}),
          });
          await invoke('stop_activity_monitoring').catch(() => {});
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
            });
            await invoke('stop_activity_monitoring').catch(() => {});
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
            await TimerEngineAPI.pause();
            const pausedState = await TimerEngineAPI.getState();
            set({
              isPaused: pausedState.state === 'PAUSED',
              isTracking: pausedState.state === 'PAUSED',
              isLoading: false,
              error: null,
              idlePauseStartTime: isIdlePause ? Date.now() : null,
            });
            await invoke('stop_activity_monitoring').catch(() => {});
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
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        timerState = await TimerEngineAPI.pause();
      } catch (timerError: any) {
        if (timerError.message?.includes('already paused') || 
            timerError.message?.includes('stopped') ||
            timerError.message?.includes('Cannot pause')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          await invoke('show_notification', {
            title: 'Timer error',
            body: 'Could not pause timer',
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
      const isPaused = timerState?.state === 'PAUSED' || false;
      
      // OPTIMISTIC: Обновляем UI сразу после Timer Engine — без ожидания API
      set({
        currentTimeEntry: timeEntryToPause,
        isPaused: isPaused,
        isLoading: false,
        error: !isPaused ? 'Could not pause' : null,
        localTimerStartTime: null,
        idlePauseStartTime: pauseStartTime,
      });
      
      // Stop monitoring immediately (local, fast)
      invoke('stop_activity_monitoring').catch((e) => {
        logger.debug('PAUSE', 'Failed to stop activity monitoring (non-critical)', e);
      });
      
      // API в фоне, только если пауза успешна (пропускаем temp id — запись ещё не создана)
      if (isPaused && !entryIdToPause.startsWith('temp-')) (async () => {
        try {
          await get().sendUrlActivities();
        } catch (e) {
          logger.warn('PAUSE', 'Failed to send URL activities (background)', e);
        }
        try {
          const accessToken = api.getAccessToken();
          const refreshToken = localStorage.getItem('refresh_token');
          let queueId: number | null = null;
          if (accessToken) {
            queueId = await invoke<number>('enqueue_time_entry', {
              operation: 'pause',
              payload: { id: entryIdToPause },
              accessToken: accessToken,
              refreshToken: refreshToken || null,
            }).catch((e) => {
              logger.warn('PAUSE', 'Failed to enqueue (background)', e);
              return null;
            });
          }
          await api.pauseTimeEntry(entryIdToPause);
          await api.sendHeartbeat(false);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
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
          }).catch(() => {});
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
        set({ idlePauseStartTime: Date.now() });
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
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, idlePauseStartTime: null, lastResumeTime: null, localTimerStartTime: null } : {}),
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

  resumeTracking: async (_fromIdleWindow: boolean = false) => {
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
        invoke('hide_idle_window').catch(() => {});
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
      invoke('hide_idle_window').catch(() => {});
      return;
    }

    // BUG FIX: Allow resuming Timer Engine even without currentTimeEntry
    // Timer Engine is the source of truth - if it's PAUSED, user should be able to resume
    // This handles cases like system wake when timer was paused but entry wasn't loaded
    if (!initialTimeEntry) {
      logger.info('RESUME', 'No currentTimeEntry, but Timer Engine is PAUSED - resuming Timer Engine only');
      try {
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
          lastActivityTime: resumeTimeNoEntry, // FIX: Prevent immediate idle re-trigger (Windows)
          lastResumeTime: resumeTimeNoEntry, // BUG FIX: Track resume time to prevent sync from pausing immediately after resume
          localTimerStartTime: resumeTimeNoEntry, // BUG FIX: Track local resume time to prevent auto-pause from syncTimerState
        });
        invoke('start_activity_monitoring').catch((e) => {
          logger.error('RESUME', 'Failed to start activity monitoring on resume (no entry)', e);
        });
        invoke('hide_idle_window').catch(() => {});
        // Try to load active time entry after resume
        await get().loadActiveTimeEntry();
        // FIX: Sync resume with server — loadActiveTimeEntry may have set PAUSED entry, we need to resume it on API
        const entryAfterLoad = get().currentTimeEntry;
        if (entryAfterLoad && !entryAfterLoad.id.startsWith('temp-')) {
          (async () => {
            try {
              const accessToken = api.getAccessToken();
              const refreshToken = localStorage.getItem('refresh_token');
              let queueId: number | null = null;
              if (accessToken) {
                queueId = await invoke<number>('enqueue_time_entry', {
                  operation: 'resume',
                  payload: { id: entryAfterLoad.id },
                  accessToken,
                  refreshToken: refreshToken || null,
                }).catch((e) => { logger.warn('RESUME', 'Failed to enqueue (no-entry branch)', e); return null; });
              }
              await api.resumeTimeEntry(entryAfterLoad.id);
              await api.sendHeartbeat(true);
              if (queueId != null) {
                await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
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
      
      // FIX: Проверяем актуальный статус entry на сервере перед попыткой возобновления
      // Это предотвращает ошибку "Only paused entries can be resumed" если entry уже не на паузе
      try {
        const activeEntries = await api.getActiveTimeEntries();
        const serverEntry = activeEntries.find(e => e.id === timeEntryToResume.id);
        
        if (serverEntry) {
          if (serverEntry.status === 'RUNNING') {
            // Entry уже запущен на сервере - синхронизируем локальное состояние
            logger.info('RESUME', 'Entry already RUNNING on server, syncing local state');
            const timerState = await TimerEngineAPI.getState();
            if (timerState.state !== 'RUNNING') {
              try {
                await TimerEngineAPI.resume();
              } catch (e: any) {
                if (!e.message?.includes('already running')) {
                  logger.warn('RESUME', 'Failed to resume Timer Engine', e);
                }
              }
            }
            const syncResumeTime = Date.now();
            set({
              currentTimeEntry: serverEntry,
              isPaused: false,
              isTracking: true,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
              lastActivityTime: syncResumeTime, // FIX: Prevent immediate idle re-trigger (Windows)
              lastResumeTime: syncResumeTime,
              localTimerStartTime: syncResumeTime,
            });
            invoke('start_activity_monitoring').catch((e) => {
              logger.error('RESUME', 'Failed to start activity monitoring on sync resume', e);
            });
            invoke('hide_idle_window').catch(() => {});
            return;
          } else if (serverEntry.status === 'STOPPED') {
            // Entry остановлен на сервере - синхронизируем локальное состояние и Timer Engine
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
              lastResumeTime: null,
              localTimerStartTime: null,
            });
            invoke('hide_idle_window').catch(() => {}); // FIX: Entry stopped on server — sync state
            try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ }
            return;
          } else if (serverEntry.status !== 'PAUSED') {
            // Entry в неожиданном статусе
            throw new Error(`Entry status on server is ${serverEntry.status}, expected PAUSED`);
          }
        }
      } catch (syncError: any) {
        logger.warn('RESUME', 'Failed to check server entry status, proceeding with resume', syncError);
        // Продолжаем попытку возобновления - возможно, это временная проблема сети
      }
      
      // OPTIMISTIC: Сначала Timer Engine (локально), сразу обновляем UI
      const entryIdToResume = timeEntryToResume.id;
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        timerState = await TimerEngineAPI.resume();
      } catch (timerError: any) {
        if (timerError.message?.includes('already running')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          await invoke('show_notification', {
            title: 'Timer error',
            body: 'Could not resume timer',
          }).catch((e) => {
            logger.warn('RESUME', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch(() => null);
        }
      }
      
      const isResumed = timerState?.state === 'RUNNING' || false;
      const resumeTime = Date.now();
      
      // OPTIMISTIC: Обновляем UI сразу (sync with Timer Engine when resume failed)
      const isPausedActual = timerState?.state === 'PAUSED' || false;
      const isTrackingActual = timerState?.state === 'RUNNING' || timerState?.state === 'PAUSED' || false;
      set({
        currentTimeEntry: timeEntryToResume,
        isPaused: isResumed ? false : isPausedActual,
        isTracking: isResumed ? true : isTrackingActual,
        lastActivityTime: resumeTime,
        isLoading: false,
        error: !isResumed ? 'Could not resume timer' : null,
        idlePauseStartTime: isResumed ? null : (get().idlePauseStartTime ?? null), // FIX: Preserve idle when resume failed
        lastResumeTime: isResumed ? resumeTime : get().lastResumeTime,
        localTimerStartTime: isResumed ? resumeTime : get().localTimerStartTime,
      });
      
      if (isResumed) {
        invoke('start_activity_monitoring').catch((e) => {
          logger.error('RESUME', 'Failed to start activity monitoring on resume', e);
        });
        invoke('hide_idle_window').catch(() => {});
      }
      
      // API в фоне (пропускаем temp id — запись ещё не создана)
      if (isResumed && !entryIdToResume.startsWith('temp-')) (async () => {
        try {
          const accessToken = api.getAccessToken();
          const refreshToken = localStorage.getItem('refresh_token');
          let queueId: number | null = null;
          if (accessToken) {
            queueId = await invoke<number>('enqueue_time_entry', {
              operation: 'resume',
              payload: { id: entryIdToResume },
              accessToken: accessToken,
              refreshToken: refreshToken || null,
            }).catch((e) => {
              logger.warn('RESUME', 'Failed to enqueue (background)', e);
              return null;
            });
          }
          await api.resumeTimeEntry(entryIdToResume);
          await api.sendHeartbeat(true);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
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
              lastResumeTime: resumeTimeForSync, // BUG FIX: Track resume time to prevent sync from pausing immediately after resume
              localTimerStartTime: resumeTimeForSync, // BUG FIX: Track local resume time to prevent auto-pause from syncTimerState
            });
            invoke('start_activity_monitoring').catch(() => {}); // FIX: Sync to RUNNING — start monitoring
            invoke('hide_idle_window').catch(() => {});
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
    
    // Если нет currentTimeEntry, но таймер работает — пробуем загрузить с сервера
    if (!timeEntryToStop) {
      const currentUser = getCurrentUser() ?? useAuthStore.getState().user;
      if (currentUser) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          const userEntry = activeEntries.find((e) => e.userId === currentUser.id);
          if (userEntry) {
            timeEntryToStop = userEntry;
          }
        } catch (_) {}
      }
    }

    // Если по-прежнему нет currentTimeEntry — просто останавливаем движок
    if (!timeEntryToStop) {
      try {
        const timerState = await TimerEngineAPI.getState();
        if (timerState.state !== 'STOPPED') {
          await TimerEngineAPI.stop();
        }
        await invoke('stop_activity_monitoring');
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
          localTimerStartTime: null,
          lastResumeTime: null,
        });
        invoke('hide_idle_window').catch(() => {});
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
      
      // OPTIMISTIC: Сначала Timer Engine (локально), сразу обновляем UI
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        timerState = await TimerEngineAPI.stop();
      } catch (timerError: any) {
        if (timerError.message?.includes('already stopped')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          await invoke('show_notification', {
            title: 'Timer error',
            body: 'Could not stop timer',
          }).catch((e) => {
            logger.warn('STOP', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch(() => null);
        }
      }
      
      const isStopped = timerState?.state === 'STOPPED' || false;
      
      // OPTIMISTIC: Обновляем UI сразу
      set({
        currentTimeEntry: null,
        isTracking: timerState?.state === 'RUNNING' || timerState?.state === 'PAUSED' || false,
        isPaused: timerState?.state === 'PAUSED' || false,
        isLoading: false,
        error: !isStopped ? 'Could not stop timer' : null,
        idlePauseStartTime: null,
        localTimerStartTime: null,
        lastResumeTime: null,
      });
      
      invoke('stop_activity_monitoring').catch((e) => {
        logger.warn('STOP', 'Failed to stop activity monitoring', e);
      });
      
      invoke('hide_idle_window').catch(() => {});
      
      // API в фоне (пропускаем если entry с temp id — запись ещё не создана на сервере)
      if (isStopped && !entryIdToStop.startsWith('temp-')) (async () => {
        try {
          await get().sendUrlActivities();
        } catch (e) {
          logger.warn('STOP', 'Failed to send URL activities (background)', e);
        }
        try {
          const accessToken = api.getAccessToken();
          const refreshToken = localStorage.getItem('refresh_token');
          let queueId: number | null = null;
          if (accessToken) {
            queueId = await invoke<number>('enqueue_time_entry', {
              operation: 'stop',
              payload: { id: entryIdToStop },
              accessToken: accessToken,
              refreshToken: refreshToken || null,
            }).catch((e) => {
              logger.warn('STOP', 'Failed to enqueue (background)', e);
              return null;
            });
          }
          await api.stopTimeEntry(entryIdToStop);
          await api.sendHeartbeat(false);
          if (queueId != null) {
            await invoke('mark_task_sent_by_id', { id: queueId }).catch(() => {});
          }
        } catch (apiError: any) {
          logger.warn('STOP', 'API failed (background), queue will retry', apiError);
          invoke('show_notification', {
            title: 'Sync',
            body: 'Timer stopped, but could not sync with server',
          }).catch(() => {});
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
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, idlePauseStartTime: null, lastResumeTime: null, localTimerStartTime: null } : {}),
          });
          if (timerState.state === 'STOPPED') {
            invoke('hide_idle_window').catch(() => {}); // FIX: Sync to STOPPED — ensure idle window hidden
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

  updateActivityTime: () => {
    const now = Date.now();
    set({ lastActivityTime: now });
    // Log activity update for debugging (async, don't block)
    logger.safeLogToRust(`[ACTIVITY] Activity detected, updated time: ${new Date(now).toLocaleTimeString()}`).catch((e) => {
      logger.debug('ACTIVITY', 'Failed to log (non-critical)', e);
    });
  },

  setIdleThreshold: (minutes: number) => {
    set({ idleThreshold: minutes });
  },

  checkIdleStatus: async () => {
    const { lastActivityTime, idleThreshold, isLoading, idlePauseStartTime } = get();
    
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

    const now = Date.now();
    // Validate: ensure no NaN or negative values
    const timeDiff = now - lastActivityTime;
    const idleTime = isNaN(timeDiff) ? 0 : Math.max(0, timeDiff) / 1000 / 60; // minutes
    
    await logger.safeLogToRust(`[IDLE CHECK] Idle time: ${idleTime.toFixed(2)} min, threshold: ${idleThreshold} min, lastActivity: ${new Date(lastActivityTime).toLocaleTimeString()}`);
    
    if (idleTime >= idleThreshold) {
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
            idlePauseStartTime: null, // FIX: Syncing to Timer Engine — not idle (store had stale RUNNING)
            ...(currentTimerState === 'STOPPED'
              ? { currentTimeEntry: null, lastResumeTime: null, localTimerStartTime: null }
              : {}),
          });
          invoke('hide_idle_window').catch(() => {}); // FIX: Ensure idle window hidden when syncing
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
      
      // Also check if time entry is already paused on server
      const storeState = get();
      if (storeState.currentTimeEntry?.status === 'PAUSED') {
        await logger.safeLogToRust(`[IDLE CHECK] Time entry already paused on server, syncing with Timer Engine`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        // Sync with Timer Engine state (source of truth)
        try {
          const timerStateForSync = await TimerEngineAPI.getState();
          set({
            isPaused: timerStateForSync.state === 'PAUSED',
            isTracking: timerStateForSync.state === 'PAUSED' || timerStateForSync.state === 'RUNNING',
            idlePauseStartTime: null, // FIX: Syncing to Timer Engine — not idle
            ...(timerStateForSync.state === 'STOPPED'
              ? { currentTimeEntry: null, lastResumeTime: null, localTimerStartTime: null }
              : {}),
          });
          invoke('hide_idle_window').catch(() => {}); // FIX: Ensure idle window hidden when syncing
        } catch (e) {
          // BUG FIX: If can't get Timer Engine state, don't assume paused
          // Server state might be stale, so we should not set isPaused without Timer Engine confirmation
          logger.warn('IDLE_CHECK', 'Cannot get Timer Engine state, cannot confirm pause status', e);
          // Don't set isPaused - let syncTimerState handle it later
          // Setting isPaused: true without Timer Engine confirmation can cause desync
        }
        return;
      }
      
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
            
            invoke('update_idle_state', {
              idlePauseStartTime: pauseTimeForRust,
              isLoading: false,
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
          
          // Send notification
          await invoke('show_notification', {
            title: 'Tracker paused',
            body: `No activity for more than ${idleThreshold} minutes`,
          });
        } else {
          logger.warn('IDLE_CHECK', 'Pause function returned but isPaused is still false!');
          await logger.safeLogToRust(`[IDLE CHECK] WARNING: Pause function returned but isPaused is still false!`).catch((e) => {
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
              set({ isPaused: false, idlePauseStartTime: null, lastResumeTime: Date.now() });
            }
          } catch (e) {
            // Если не удалось проверить Timer Engine, очищаем состояние
            set({ isPaused: false, idlePauseStartTime: null });
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
      isLoading: false,
      error: null,
      idlePauseStartTime: null,
      urlActivities: [],
      localTimerStartTime: null,
      lastResumeTime: null,
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
        ? { currentTimeEntry: null, idlePauseStartTime: null, lastResumeTime: null, localTimerStartTime: null }
        : {}),
    });
    if (state.state === 'STOPPED') {
      invoke('hide_idle_window').catch(() => {}); // FIX: Idle window visible when day changed
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
      localTimerStartTime: null, // Clear local timer start time
      lastResumeTime: null, // Clear resume time on stop
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
            });
            invoke('hide_idle_window').catch(() => {});
          }
          return;
        }
        
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
                lastResumeTime: null,
                localTimerStartTime: null,
              }
            : timerState.state === 'RUNNING'
              ? { idlePauseStartTime: null } // FIX: Clear idle — Timer Engine RUNNING means we're not idle
              : {}),
        });
        
        await logger.safeLogToRust(`[STATE_INVARIANT] Auto-synced: isTracking=${expectedTracking}, isPaused=${expectedPaused} (was: store=${storeState.isTracking}/${storeState.isPaused}, engine=${timerState.state})`).catch((e) => {
          logger.debug('STATE_INVARIANT', 'Failed to log (non-critical)', e);
        });
        if (timerState.state === 'RUNNING' || timerState.state === 'STOPPED') {
          invoke('hide_idle_window').catch(() => {}); // FIX: Idle window must be hidden when not in idle
        }
        if (timerState.state === 'RUNNING') {
          invoke('start_activity_monitoring').catch(() => {}); // FIX: Sync to RUNNING — ensure monitoring
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

