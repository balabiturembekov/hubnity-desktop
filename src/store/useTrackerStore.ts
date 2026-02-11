import { create } from 'zustand';
import { api, Project, TimeEntry, UrlActivity } from '../lib/api';
import type { Screenshot } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentUser } from '../lib/current-user';
import { TimerEngineAPI, type TimerStateResponse } from '../lib/timer-engine';
import { logger } from '../lib/logger';

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
      const currentUser = getCurrentUser();
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
        // No entries for current user - clear state
        await get().clearTrackingStateFromServer();
        return;
      }

      {
        let activeEntry: TimeEntry;
        
        // FIX: Если несколько активных записей, выбираем самую свежую и останавливаем остальные
        // NOTE: userEntries уже отфильтрованы по userId текущего пользователя
        if (userEntries.length > 1) {
          logger.warn('LOAD', `Multiple active time entries found (${userEntries.length}), resolving duplicates...`);
          
          // Сортируем по startTime (самая свежая первая)
          const sortedEntries = [...userEntries].sort((a, b) => 
            new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          );
          
          // Выбираем самую свежую запись
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
              // Таймер работает, но entry на паузе - паузим таймер
              logger.info('LOAD', 'Timer Engine is RUNNING but entry is PAUSED, pausing timer');
              await TimerEngineAPI.pause();
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
        
        set({
          currentTimeEntry: activeEntry,
          isTracking: activeEntry.status === 'RUNNING' || activeEntry.status === 'PAUSED',
          isPaused: activeEntry.status === 'PAUSED',
          lastActivityTime: Date.now(),
          selectedProject: restoredProject,
        });
      }
    } catch (error: any) {
      // Silently fail - active entry might not exist
    }
  },

  selectProject: async (project: Project) => {
    const { isTracking, currentTimeEntry } = get();
    // Этап 2: при смене проекта во время трекинга сначала останавливаем таймер (как в Hubstaff)
    if (isTracking && currentTimeEntry) {
      logger.info('SELECT_PROJECT', 'Stopping tracking before switching project');
      try {
        await get().stopTracking();
      } catch (e) {
        logger.error('SELECT_PROJECT', 'Failed to stop tracking before project switch', e);
        set({ error: 'Не удалось остановить таймер перед сменой проекта' });
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

    const user = getCurrentUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    try {
      set({ isLoading: true, error: null });
      
      // Check for active time entries first
      const activeEntries = await api.getActiveTimeEntries();
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
          
          set({
            currentTimeEntry: activeEntry,
            isTracking: true,
            isPaused: false,
            lastActivityTime: Date.now(),
            selectedProject: restoredProject,
            isLoading: false,
            error: null,
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
              // Таймер работает, но entry на паузе - паузим таймер
              logger.info('START', 'Timer Engine is RUNNING but entry is PAUSED, pausing timer');
              await TimerEngineAPI.pause();
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
          
          // Восстанавливаем состояние без error - UI покажет paused состояние с кнопками
          set({
            currentTimeEntry: activeEntry,
            isTracking: true,
            isPaused: true,
            selectedProject: restoredProject,
            isLoading: false,
            error: null, // Убираем error - состояние восстановлено, пользователь видит кнопки
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
        requestData.description = `Работа над проектом ${selectedProject.name}`;
      }
      
      // Сохраняем в очередь синхронизации (offline-first)
      const accessToken = api.getAccessToken();
      const refreshToken = localStorage.getItem('refresh_token');
      if (accessToken) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('enqueue_time_entry', {
            operation: 'start',
            payload: requestData,
            accessToken: accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => {
            logger.warn('START', 'Failed to enqueue, will use direct API', e);
          });
        } catch (e) {
          logger.warn('START', 'Queue unavailable, will use direct API', e);
        }
      }
      
      // Прямой вызов API для немедленного обновления UI
      // Если API недоступен, данные останутся в очереди и синхронизируются позже
      const timeEntry = await api.startTimeEntry(requestData);
      
      // Запускаем Timer Engine в Rust (единственный source of truth для времени)
      let timerState;
      try {
        // Сначала проверяем текущее состояние таймера
        const currentTimerState = await TimerEngineAPI.getState();
        
        // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
        if (currentTimerState.state === 'STOPPED') {
          // Таймер остановлен - запускаем
          timerState = await TimerEngineAPI.start();
        } else if (currentTimerState.state === 'PAUSED') {
          // Таймер на паузе - возобновляем
          timerState = await TimerEngineAPI.resume();
        } else if (currentTimerState.state === 'RUNNING') {
          // Таймер уже запущен - используем текущее состояние
          timerState = currentTimerState;
        } else {
          // Неизвестное состояние - пытаемся запустить
          timerState = await TimerEngineAPI.start();
        }
      } catch (timerError: any) {
        // Если таймер уже запущен или на паузе, получаем текущее состояние
        if (timerError.message?.includes('already running') || 
            timerError.message?.includes('already paused')) {
          timerState = await TimerEngineAPI.getState();
        } else {
          // Другая ошибка - показываем toast и продолжаем
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_notification', {
            title: 'Ошибка таймера',
            body: 'Не удалось запустить таймер, но запись времени создана',
          }).catch((e) => {
            logger.warn('START', 'Failed to show notification (non-critical)', e);
          });
          // Продолжаем - API запись создана
          timerState = await TimerEngineAPI.getState().catch((e) => {
            logger.logError('START:getState_fallback', e);
            return null;
          });
        }
      }
      
      // Start activity monitoring (don't fail if this fails)
      try {
        await invoke('start_activity_monitoring');
      } catch (monitoringError) {
        logger.error('START', 'Failed to start activity monitoring', monitoringError);
      }
      
      // Send initial heartbeat (don't fail if this fails)
      try {
        await api.sendHeartbeat(true);
      } catch (heartbeatError) {
        logger.error('START', 'Failed to send initial heartbeat', heartbeatError);
      }
      
      // Обновляем UI state на основе Timer Engine
      // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
      set({
        currentTimeEntry: timeEntry,
        isTracking: timerState?.state === 'RUNNING' || false,
        isPaused: timerState?.state === 'PAUSED' || false,
        lastActivityTime: Date.now(),
        isLoading: false,
        error: null,
      });
    } catch (error: any) {
      set({ error: error.message || 'Failed to start tracking', isLoading: false });
      throw error;
    }
  },

  pauseTracking: async (isIdlePause: boolean = false) => {
    const { currentTimeEntry, isLoading: currentLoading } = get();
    if (!currentTimeEntry) {
      await logger.safeLogToRust('[PAUSE] No current time entry, skipping').catch((e) => {
        logger.debug('PAUSE', 'Failed to log (non-critical)', e);
      });
      return;
    }
    
    // GUARD: Prevent multiple simultaneous calls - устанавливаем isLoading СРАЗУ
    if (currentLoading) {
      const { invoke } = await import('@tauri-apps/api/core');
      invoke('log_message', { message: '[PAUSE] Already loading, skipping' }).catch((e) => {
        logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
      });
      return;
    }
    
    // Устанавливаем isLoading СРАЗУ для защиты от race condition
    set({ isLoading: true });
    
    // Проверяем состояние еще раз после установки isLoading (double-check)
    const stateAfterLock = get();
    if (stateAfterLock.isPaused && !isIdlePause) {
      set({ isLoading: false });
      const { invoke } = await import('@tauri-apps/api/core');
      invoke('log_message', { message: '[PAUSE] Already paused (double-check), skipping' }).catch((e) => {
        logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
      });
      return;
    }

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('log_message', { message: `[PAUSE] Starting pause for timeEntry: ${currentTimeEntry.id}, isIdlePause: ${isIdlePause}` }).catch((e) => {
      logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
    });

    try {
      set({ error: null }); // Clear previous errors (isLoading уже установлен выше)
      
      // Send accumulated URL activities before pausing
      try {
        await get().sendUrlActivities();
      } catch (e) {
        // Log but don't fail pause operation if URL activities send fails
        logger.warn('PAUSE', 'Failed to send URL activities before pause', e);
        await invoke('log_message', { message: `[PAUSE] Failed to send URL activities before pause: ${e}` }).catch((err) => {
          logger.debug('PAUSE', 'Failed to log message (non-critical)', err);
        });
      }
      
      // Сохраняем в очередь синхронизации (offline-first)
      const accessToken = api.getAccessToken();
      const refreshToken = localStorage.getItem('refresh_token');
      if (accessToken) {
        try {
          await invoke('enqueue_time_entry', {
            operation: 'pause',
            payload: { id: currentTimeEntry.id },
            accessToken: accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => {
            logger.warn('PAUSE', 'Failed to enqueue, will use direct API', e);
          });
        } catch (e) {
          logger.warn('PAUSE', 'Queue unavailable, will use direct API', e);
        }
      }
      
      // Сначала паузим Timer Engine в Rust (единственный source of truth)
      // Rust FSM проверит валидность перехода и вернет ошибку, если переход недопустим
      let timerState: import('../lib/timer-engine').TimerStateResponse | null = null;
      try {
        timerState = await TimerEngineAPI.pause();
      } catch (timerError: any) {
        // Если таймер уже на паузе или остановлен, получаем текущее состояние
        if (timerError.message?.includes('already paused') || 
            timerError.message?.includes('stopped') ||
            timerError.message?.includes('Cannot pause')) {
          await invoke('log_message', { 
            message: `[PAUSE] Timer Engine rejected pause: ${timerError.message}. Getting current state.` 
          }).catch((e) => {
            logger.debug('PAUSE', 'Failed to log message (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState();
        } else {
          // Другая ошибка - показываем toast, но продолжаем с API паузой
          await invoke('show_notification', {
            title: 'Ошибка таймера',
            body: 'Не удалось приостановить таймер, но попытаемся обновить запись на сервере',
          }).catch((e) => {
            logger.warn('PAUSE', 'Failed to show notification (non-critical)', e);
          });
          timerState = await TimerEngineAPI.getState().catch((e) => {
            logger.logError('START:getState_fallback', e);
            return null;
          });
        }
      }
      
      // Вызываем API для паузы time entry (для синхронизации с сервером)
      // Если Timer Engine уже на паузе, API может вернуть ошибку, но это нормально
      await logger.safeLogToRust('[PAUSE] Calling API pauseTimeEntry...');
      let timeEntry: TimeEntry | null = null;
      try {
        timeEntry = await api.pauseTimeEntry(currentTimeEntry.id);
      } catch (apiError: any) {
        // Если entry уже на паузе на сервере, это нормально - просто обновляем локальное состояние
        if (apiError.message?.includes('Only running entries can be paused') ||
            apiError.message?.includes('already paused')) {
          await logger.safeLogToRust(`[PAUSE] Entry already paused on server: ${apiError.message}`).catch((e) => {
            logger.debug('PAUSE', 'Failed to log (non-critical)', e);
          });
          // Получаем актуальное состояние entry с сервера
          try {
            const activeEntries = await api.getActiveTimeEntries();
            timeEntry = activeEntries.find(e => e.id === currentTimeEntry.id) || currentTimeEntry;
          } catch {
            timeEntry = currentTimeEntry; // Fallback
          }
        } else {
          // Другая ошибка - пробрасываем дальше
          throw apiError;
        }
      }
      
      // Используем состояние Timer Engine как источник истины
      // Если Timer Engine на паузе, значит пауза успешна, независимо от ответа API
      
      // Stop monitoring when paused
      try {
        await invoke('stop_activity_monitoring');
      } catch (monitoringError) {
        // Continue anyway
      }
      
      // Send heartbeat
      try {
        await api.sendHeartbeat(false);
      } catch (heartbeatError) {
        // Continue anyway
      }
      
      // Set idlePauseStartTime only if this is an idle pause
      // idlePauseStart используется ниже в update_idle_state
      
      // Обновляем UI state на основе Timer Engine (единственный source of truth)
      // Timer Engine уже проверил валидность перехода через FSM
      // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
      const isPaused = timerState?.state === 'PAUSED' || false;
      
      // FIX: Устанавливаем idlePauseStartTime для idle pause
      // Если это idle pause, устанавливаем время паузы сразу (проверим после set, что пауза успешна)
      // Используем более надежную логику: устанавливаем для idle pause, затем проверяем
      const pauseStartTime = isIdlePause ? Date.now() : null;
      
      logger.debug('PAUSE', `Setting idlePauseStartTime: ${pauseStartTime}, isIdlePause: ${isIdlePause}, isPaused: ${isPaused}, timerState: ${timerState?.state}`);
      
      set({
        currentTimeEntry: timeEntry || currentTimeEntry, // Используем обновленное entry, если есть
        isPaused: isPaused,
        isLoading: false,
        error: null,
        idlePauseStartTime: pauseStartTime, // Устанавливаем для idle pause, проверим после
      });
      
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
        try { await TimerEngineAPI.stop(); } catch (_) { /* ignore */ }
        try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ }
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
        });
        try { await invoke('hide_idle_window'); } catch (_) { /* ignore */ }
      } else {
        // Проверяем реальное состояние Timer Engine при ошибке
        try {
          const timerState = await TimerEngineAPI.getState();
          // Синхронизируем состояние с Timer Engine
          set({
            isPaused: timerState.state === 'PAUSED',
            isTracking: timerState.state === 'RUNNING' || timerState.state === 'PAUSED',
            isLoading: false,
            error: msg,
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null, idlePauseStartTime: null } : {}),
          });
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

  resumeTracking: async (fromIdleWindow: boolean = false) => {
    const { currentTimeEntry, isLoading: currentLoading, isPaused, idlePauseStartTime } = get();
    if (!currentTimeEntry) return;
    
    // Prevent multiple simultaneous calls
    if (currentLoading) {
      return;
    }
    
    // CRITICAL: Prevent auto-resume if paused due to idle - user must decide via idle window
    // But allow resume if explicitly called from idle window (user clicked Resume button)
    if (isPaused && idlePauseStartTime !== null && !fromIdleWindow) {
      logger.warn('RESUME', 'Attempted to resume while paused due to idle - ignoring (user must decide via idle window)');
      await logger.safeLogToRust('[RESUME] Blocked: timer paused due to idle, user must decide via idle window').catch((e) => {
        logger.debug('RESUME', 'Failed to log (non-critical)', e);
      });
      return;
    }
    
    // Prevent resuming if already running (not paused)
    if (!isPaused) {
      await logger.safeLogToRust('[RESUME] Already running, skipping').catch((e) => {
        logger.debug('RESUME', 'Failed to log (non-critical)', e);
      });
      return;
    }

    try {
      set({ isLoading: true, error: null });
      
      // FIX: Проверяем актуальный статус entry на сервере перед попыткой возобновления
      // Это предотвращает ошибку "Only paused entries can be resumed" если entry уже не на паузе
      try {
        const activeEntries = await api.getActiveTimeEntries();
        const serverEntry = activeEntries.find(e => e.id === currentTimeEntry.id);
        
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
            set({
              currentTimeEntry: serverEntry,
              isPaused: false,
              isTracking: true,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
            });
            return;
          } else if (serverEntry.status === 'STOPPED') {
            // Entry остановлен на сервере - синхронизируем локальное состояние
            logger.info('RESUME', 'Entry is STOPPED on server, syncing local state');
            set({
              currentTimeEntry: null,
              isPaused: false,
              isTracking: false,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
            });
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
      
      // Сохраняем в очередь синхронизации (offline-first)
      const accessToken = api.getAccessToken();
      const refreshToken = localStorage.getItem('refresh_token');
      if (accessToken) {
        try {
          await invoke('enqueue_time_entry', {
            operation: 'resume',
            payload: { id: currentTimeEntry.id },
            accessToken: accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => {
            logger.warn('RESUME', 'Failed to enqueue, will use direct API', e);
          });
        } catch (e) {
          logger.warn('RESUME', 'Queue unavailable, will use direct API', e);
        }
      }
      
      // Вызываем API для возобновления time entry (для немедленного обновления UI)
      const timeEntry = await api.resumeTimeEntry(currentTimeEntry.id);
      
      // Validate response
      if (!timeEntry || !timeEntry.id || timeEntry.status !== 'RUNNING') {
        throw new Error('Invalid resume response from server');
      }
      
      // Возобновляем Timer Engine в Rust
      try {
        await TimerEngineAPI.resume();
      } catch (timerError: any) {
        // Если таймер уже запущен, это нормально
        if (!timerError.message?.includes('already running')) {
          // Другая ошибка - показываем toast
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_notification', {
            title: 'Ошибка таймера',
            body: 'Не удалось возобновить таймер, но запись времени обновлена',
          }).catch((e) => {
            logger.warn('RESUME', 'Failed to show notification (non-critical)', e);
          });
        }
      }
      
      // Start activity monitoring
      try {
        await invoke('start_activity_monitoring');
      } catch (monitoringError) {
        logger.error('RESUME', 'Failed to start activity monitoring on resume', monitoringError);
      }
      
      // Send heartbeat
      try {
        await api.sendHeartbeat(true);
      } catch (heartbeatError) {
        logger.error('RESUME', 'Failed to send heartbeat on resume', heartbeatError);
      }
      
      // Обновляем UI state
      set({
        currentTimeEntry: timeEntry,
        isPaused: false,
        isTracking: true,
        lastActivityTime: Date.now(),
        isLoading: false,
        error: null,
        idlePauseStartTime: null, // Clear idle pause time on resume
      });
      
      // Hide idle window on resume
      try {
        await invoke('hide_idle_window');
      } catch (error) {
        // Ignore errors
      }
    } catch (error: any) {
      const msg = error.message || 'Failed to resume tracking';
      const needSyncFromServer = typeof msg === 'string' && (msg.includes('already running') || msg.includes('Only paused entries can be resumed'));
      const entryStoppedOrGone = typeof msg === 'string' && (msg.includes('already stopped') || msg.includes('not found') || msg.includes('Invalid resume') || msg.includes('Only paused entries can be resumed'));
      if (needSyncFromServer) {
        try {
          const activeEntries = await api.getActiveTimeEntries();
          const serverEntry = activeEntries.find(e => e.id === currentTimeEntry.id);
          if (serverEntry?.status === 'RUNNING') {
            try { await TimerEngineAPI.resume(); } catch (_) { /* already running */ }
            set({
              currentTimeEntry: serverEntry,
              isPaused: false,
              isTracking: true,
              isLoading: false,
              error: null,
              idlePauseStartTime: null,
            });
            return;
          }
        } catch (_) {
          // fetch failed — don't assume state, fall through to generic error
        }
      }
      if (entryStoppedOrGone) {
        try { await TimerEngineAPI.stop(); } catch (_) { /* ignore */ }
        try { await invoke('stop_activity_monitoring'); } catch (_) { /* ignore */ }
        set({
          currentTimeEntry: null,
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
        });
        try { await invoke('hide_idle_window'); } catch (_) { /* ignore */ }
        return;
      }
      set({ error: msg, isLoading: false });
      try {
        await invoke('stop_activity_monitoring');
      } catch (e) {
        // Ignore
      }
    }
  },

  stopTracking: async () => {
    const { currentTimeEntry, isLoading: currentLoading, isTracking } = get();
    
    // Prevent multiple simultaneous calls
    if (currentLoading) {
      return;
    }
    
    // Prevent stopping if already stopped
    if (!isTracking) {
      return;
    }
    
    // Если нет currentTimeEntry, но таймер работает - просто останавливаем движок
    // Это может произойти при синхронизации после того, как запись уже остановлена
    if (!currentTimeEntry) {
      // Останавливаем только Timer Engine, без API вызова и без логирования
      try {
        await TimerEngineAPI.stop();
        await invoke('stop_activity_monitoring');
        set({
          isTracking: false,
          isPaused: false,
          isLoading: false,
          error: null,
          idlePauseStartTime: null,
        });
      } catch (e) {
        // Игнорируем ошибки - это нормально если таймер уже остановлен
        logger.debug('STOP', 'Failed to stop timer engine (non-critical)', e);
      }
      return;
    }

    try {
      set({ isLoading: true, error: null }); // Clear previous errors
      
      // Send accumulated URL activities before stopping
      try {
        await get().sendUrlActivities();
      } catch (e) {
        // Log but don't fail stop operation if URL activities send fails
        logger.warn('STOP', 'Failed to send URL activities before stop', e);
        await logger.safeLogToRust(`[STOP] Failed to send URL activities before stop: ${e}`).catch((err) => {
          logger.debug('STOP', 'Failed to log (non-critical)', err);
        });
      }
      
      // Send final heartbeat before stopping
      try {
        await api.sendHeartbeat(false);
      } catch (e) {
        // Ignore heartbeat errors on stop
      }
      // Сохраняем в очередь синхронизации (offline-first)
      const accessToken = api.getAccessToken();
      const refreshToken = localStorage.getItem('refresh_token');
      if (accessToken) {
        try {
          await invoke('enqueue_time_entry', {
            operation: 'stop',
            payload: { id: currentTimeEntry.id },
            accessToken: accessToken,
            refreshToken: refreshToken || null,
          }).catch((e) => {
            logger.warn('STOP', 'Failed to enqueue, will use direct API', e);
          });
        } catch (e) {
          logger.warn('STOP', 'Queue unavailable, will use direct API', e);
        }
      }
      
      // Вызываем API для остановки time entry (для немедленного обновления UI)
      const timeEntry = await api.stopTimeEntry(currentTimeEntry.id);
      
      // Validate response
      if (!timeEntry || !timeEntry.id || timeEntry.status !== 'STOPPED') {
        logger.warn('STOP', 'Invalid stop response, but continuing');
        await logger.safeLogToRust(`[STOP] Warning: Invalid stop response, but continuing`).catch((e) => {
          logger.debug('STOP', 'Failed to log (non-critical)', e);
        });
      }
      
      // Останавливаем Timer Engine в Rust
      try {
        await TimerEngineAPI.stop();
      } catch (timerError: any) {
        // Если таймер уже остановлен, это нормально
        if (!timerError.message?.includes('already stopped')) {
          // Другая ошибка - показываем toast
          await invoke('show_notification', {
            title: 'Ошибка таймера',
            body: 'Не удалось остановить таймер, но запись времени завершена',
          }).catch((e) => {
            logger.warn('STOP', 'Failed to show notification (non-critical)', e);
          });
        }
      }
      
      await invoke('stop_activity_monitoring');
      
      // Обновляем UI state на основе Timer Engine
      set({
        currentTimeEntry: null,
        isTracking: false,
        isPaused: false,
        isLoading: false,
        error: null,
        idlePauseStartTime: null,
      });
      
      // Hide idle window on stop (after state update so subscription can send update)
      try {
        await invoke('hide_idle_window');
      } catch (error) {
        // Ignore errors
      }
    } catch (error: any) {
      const msg = error.message || 'Failed to stop tracking';
      const alreadyStopped = typeof msg === 'string' && msg.includes('already stopped');
      if (alreadyStopped) {
        // Запись уже остановлена на бэкенде — приводим UI и движок к состоянию «остановлено»
        try {
          await TimerEngineAPI.stop();
        } catch (_) {
          // ignore
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
        });
        try {
          await invoke('hide_idle_window');
        } catch (_) {
          // ignore
        }
      } else {
        set({ error: msg, isLoading: false });
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
    const { isTracking, isPaused, lastActivityTime, idleThreshold, isLoading } = get();
    
    // Don't check if not tracking, paused, or already loading (to prevent multiple pauses)
    if (!isTracking || isPaused || isLoading) {
      logger.safeLogToRust(`[IDLE CHECK] Skipped: isTracking=${isTracking}, isPaused=${isPaused}, isLoading=${isLoading}`).catch((e) => {
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
      
      // Double-check state before pausing (race condition protection)
      const currentState = get();
      if (!currentState.isTracking || currentState.isPaused || currentState.isLoading) {
        await logger.safeLogToRust(`[IDLE CHECK] State changed, skipping pause: isTracking=${currentState.isTracking}, isPaused=${currentState.isPaused}, isLoading=${currentState.isLoading}`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        return; // State changed, skip pause
      }
      
      // Проверяем состояние Timer Engine (единственный source of truth)
      // Если Timer Engine уже на паузе или остановлен, не пытаемся поставить на паузу снова
      try {
        const timerState = await TimerEngineAPI.getState();
        // FIX: Используем state напрямую (не state.state.state) из-за #[serde(flatten)] в Rust
        if (timerState.state === 'PAUSED' || timerState.state === 'STOPPED') {
          await logger.safeLogToRust(`[IDLE CHECK] Timer Engine already ${timerState.state}, updating local state and skipping pause`).catch((e) => {
            logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
          });
          const currentState = timerState.state;
          set({
            isPaused: currentState === 'PAUSED',
            isTracking: currentState === 'PAUSED',
            ...(currentState === 'STOPPED' ? { currentTimeEntry: null } : {}),
          });
          return;
        }
        // Если Timer Engine RUNNING, продолжаем с паузой
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
      if (currentState.currentTimeEntry?.status === 'PAUSED') {
        await logger.safeLogToRust(`[IDLE CHECK] Time entry already paused on server, syncing with Timer Engine`).catch((e) => {
          logger.debug('IDLE_CHECK', 'Failed to log (non-critical)', e);
        });
        // Sync with Timer Engine state (source of truth)
        try {
          const timerState = await TimerEngineAPI.getState();
          set({
            isPaused: timerState.state === 'PAUSED',
            isTracking: timerState.state === 'PAUSED' || timerState.state === 'RUNNING',
            ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null } : {}),
          });
        } catch (e) {
          // If can't get Timer Engine state, just set isPaused from server
          set({ isPaused: true });
        }
        return;
      }
      
      // Don't set isLoading here - let pauseTracking manage it
      // This prevents the "Already loading" check from blocking the pause
      
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
            title: 'Трекер приостановлен',
            body: `Нет активности более ${idleThreshold} минут`,
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
                isTracking: timerState.state === 'PAUSED',
                idlePauseStartTime: timerState.state === 'PAUSED' ? Date.now() : null,
                ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null } : {}),
              });
            } else {
              // Timer Engine не на паузе — очищаем состояние
              set({ isPaused: false, idlePauseStartTime: null });
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
              isTracking: timerState.state === 'PAUSED',
              idlePauseStartTime: timerState.state === 'PAUSED' ? Date.now() : null,
              ...(timerState.state === 'STOPPED' ? { currentTimeEntry: null } : {}),
            });
          } else {
            // Timer Engine не на паузе — очищаем состояние
            set({ isPaused: false, idlePauseStartTime: null });
          }
        } catch (e) {
          // Если не удалось проверить Timer Engine, очищаем состояние
          set({ isPaused: false, idlePauseStartTime: null });
        }
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
    
    // Don't send if tracking is paused
    if (currentState.isPaused) {
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
      ...(state.state === 'STOPPED' ? { currentTimeEntry: null } : {}),
    });
    return state;
  },

  clearTrackingStateFromServer: async () => {
    try {
      await TimerEngineAPI.stop();
    } catch (_) {
      // ignore
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
    });
    try {
      await invoke('hide_idle_window');
    } catch (_) {
      // ignore
    }
  },
}));

export type { TimerStateResponse } from '../lib/timer-engine';
export type { Screenshot } from '../lib/api';

