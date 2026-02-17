import { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { useTrackerStore, type TimerStateResponse } from '../store/useTrackerStore';
import { useSyncStore } from '../store/useSyncStore';
import { Play, Pause, Square, RotateCcw, Camera, AlertCircle, Coffee } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../lib/logger';
import { cn } from '../lib/utils';

function formatTime(seconds: number): string {
  const displaySeconds = Math.max(0, seconds);
  const hours = Math.floor(displaySeconds / 3600);
  const minutes = Math.floor((displaySeconds % 3600) / 60);
  const secs = displaySeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatTimeShort(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}` : `0:${m.toString().padStart(2, '0')}`;
}

export function Timer() {
  const {
    selectedProject,
    currentTimeEntry,
    isTracking,
    isPaused,
    startTracking,
    pauseTracking,
    resumeTracking,
    stopTracking,
    isLoading,
    error,
    isTakingScreenshot,
    idlePauseStartTime,
    idlePauseStartPerfRef,
    lastActivityTime,
    lastActivityPerfRef,
    lastTimerStateFromStart,
    clientSessionStartMs,
  } = useTrackerStore();
  const isOnline = useSyncStore((s) => s.status?.is_online ?? true);

  // Состояние таймера из Rust (единственный source of truth).
  // При start/resume: poll ещё STOPPED/PAUSED ~200ms — приоритет lastTimerStateFromStart (RUNNING) чтобы не было рассинхрона секунд.
  const [timerState, setTimerState] = useState<TimerStateResponse | null>(null);
  const pollStaleAfterStartResume =
    lastTimerStateFromStart?.state === 'RUNNING' &&
    (timerState?.state === 'PAUSED' || timerState?.state === 'STOPPED');
  const effectiveTimerState = pollStaleAfterStartResume
    ? lastTimerStateFromStart
    : (timerState ?? lastTimerStateFromStart);
  const [idleTime, setIdleTime] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // Состояние из Rust: push (timer-state-update каждые 200ms) + poll fallback. Push не throttлится в фоне.
  const POLL_MS = 200;
  useEffect(() => {
    let isMounted = true;
    let timeoutId: ReturnType<typeof setTimeout>;
    let unlistenTimer: (() => void) | null = null;

    const processState = (state: TimerStateResponse) => {
      if (!isMounted) return;
      setTimerState(state);
      const isRunning = state.state === 'RUNNING';
      const isPaused = state.state === 'PAUSED';
      const store = useTrackerStore.getState();
      const { isTracking: currentIsTracking, isPaused: currentIsPaused, currentTimeEntry } = store;
      const trackingChanged = currentIsTracking !== (isRunning || isPaused) || currentIsPaused !== isPaused;
      const needClearEntry = state.state === 'STOPPED' && currentTimeEntry !== null;
      if (trackingChanged || needClearEntry) {
        useTrackerStore.setState({
          isTracking: isRunning || isPaused,
          isPaused: isPaused,
          ...(state.state === 'STOPPED'
            ? { currentTimeEntry: null, idlePauseStartTime: null, lastResumeTime: null, localTimerStartTime: null }
            : state.state === 'RUNNING'
              ? { idlePauseStartTime: null }
              : {}),
        });
        if (state.state === 'RUNNING' || state.state === 'STOPPED') {
          invoke('hide_idle_window').catch(() => {});
        }
        if (state.state === 'RUNNING') {
          invoke('start_activity_monitoring').catch(() => {});
        }
        if ((isRunning || isPaused) && !currentTimeEntry) {
          useTrackerStore.getState().loadActiveTimeEntry().catch((e) => {
            logger.debug('TIMER', 'loadActiveTimeEntry failed (non-critical)', e);
          });
        }
      }
      const tooltip =
        state.state === 'RUNNING'
          ? `▶ ${formatTime(state.elapsed_seconds)}`
          : state.state === 'PAUSED'
            ? `⏸ ${formatTime(state.elapsed_seconds)}`
            : '⏹ 00:00:00';
      invoke('plugin:tray|set_tooltip', { id: 'main', tooltip }).catch(() => {});
    };

    const shouldSkipStalePaused = (state: TimerStateResponse) => {
      if (state.state !== 'PAUSED') return false;
      const store = useTrackerStore.getState();
      const lastFromStore = store.lastTimerStateFromStart;
      if (lastFromStore?.state !== 'RUNNING') return false;
      // Skip only if user just resumed (< 5s) — prevents stale PAUSED from overwriting fresh RUNNING
      // After wake, lastResumeTime is null or old — accept PAUSED
      const lastResumeTime = store.lastResumeTime;
      if (!lastResumeTime) return false;
      return Date.now() - lastResumeTime < 5000;
    };

    listen<TimerStateResponse>('timer-state-update', (ev) => {
      if (!isMounted) return;
      const state = ev.payload;
      if (shouldSkipStalePaused(state)) return;
      processState(state);
    }).then((fn) => {
      unlistenTimer = fn;
    });

    const pollOnce = async () => {
      if (!isMounted) return;
      try {
        const state = await useTrackerStore.getState().getTimerState();
        if (!isMounted) return;
        if (shouldSkipStalePaused(state)) return;
        processState(state);
      } catch (e) {
        logger.error('TIMER', 'Failed to get timer state', e);
      }
    };

    pollOnce();
    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        if (!isMounted) return;
        pollOnce();
        scheduleNext();
      }, POLL_MS);
    };
    scheduleNext();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      unlistenTimer?.();
    };
  }, []);

  // Проверка смены дня (локальная дата — как в Rust ensure_correct_day)
  useEffect(() => {
    let isMounted = true;
    
    const checkDayChange = async () => {
      if (!effectiveTimerState?.day_start || !isMounted) return;

      const dayStartTimestamp = effectiveTimerState.day_start;
      const today = new Date();
      const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const dayStartDate = new Date(dayStartTimestamp * 1000);
      const dayStartLocal = new Date(dayStartDate.getFullYear(), dayStartDate.getMonth(), dayStartDate.getDate()).getTime();

      const isDifferentDay = todayLocal !== dayStartLocal;

      if (isDifferentDay && isMounted) {
        try {
          const newState = await useTrackerStore.getState().resetDay();
          
          // BUG FIX: Check if component is still mounted before updating state
          if (!isMounted) return;
          
          setTimerState(newState);
        } catch (error) {
          logger.error('TIMER', 'Failed to reset day', error);
        }
      }
    };

    const dayCheckInterval = setInterval(checkDayChange, 60000);
    checkDayChange();
    return () => {
      isMounted = false;
      clearInterval(dayCheckInterval);
    };
  }, [effectiveTimerState?.day_start]);

  // Обновление idle time — performance.now() для монотонного elapsed (не прыгает при NTP)
  const idleBasePerfRef = lastActivityPerfRef ?? idlePauseStartPerfRef;
  const hasIdleBase = (lastActivityTime ?? idlePauseStartTime) && idleBasePerfRef;
  useEffect(() => {
    let isMounted = true;
    
    if (effectiveTimerState?.state === 'PAUSED' && hasIdleBase) {
      const updateIdleTime = () => {
        if (!isMounted) return;
        const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const idleSeconds = Math.floor((perfNow - idleBasePerfRef!) / 1000);
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        setIdleTime(validIdleSeconds);
      };
      
      updateIdleTime();
      const interval = setInterval(updateIdleTime, 1000);
      return () => {
        isMounted = false;
        clearInterval(interval);
      };
    } else {
      setIdleTime(0);
      return () => {
        isMounted = false;
      };
    }
  }, [effectiveTimerState?.state, idleBasePerfRef, hasIdleBase]);

  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);

  // Сбрасываем isProcessing при оптимистичном обновлении (таймер уже показывается)
  useEffect(() => {
    if ((isTracking || effectiveTimerState?.state === 'RUNNING') && isProcessing) {
      setIsProcessing(false);
    }
  }, [isTracking, effectiveTimerState?.state, isProcessing]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleStart = async () => {
    if (!selectedProject || isProcessing) return;
    setIsProcessing(true);
    try {
      await startTracking();
    } catch (error: any) {
      // Error is already set in store
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  const handlePause = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await pauseTracking();
      // BUG FIX: Force update timer state after pause to sync with Timer Engine
      // This ensures UI shows correct state even if pause had errors
      try {
        const state = await useTrackerStore.getState().getTimerState();
        if (isMountedRef.current) {
          setTimerState(state);
          // Sync store state with Timer Engine
          const isRunning = state.state === 'RUNNING';
          const isPaused = state.state === 'PAUSED';
          const storeState = useTrackerStore.getState();
          // Clear error if Timer Engine was paused successfully
          const shouldClearError = isPaused && storeState.error?.includes('pause');
          useTrackerStore.setState({
            isTracking: isRunning || isPaused,
            isPaused: isPaused,
            ...(shouldClearError ? { error: null } : {}),
          });
        }
      } catch (syncError) {
        logger.warn('TIMER', 'Failed to sync timer state after pause', syncError);
      }
    } catch (error) {
      logger.error('TIMER', 'Failed to pause tracking', error);
      // BUG FIX: Even on error, try to sync state with Timer Engine
      // If Timer Engine was paused successfully, clear error and sync state
      try {
        const state = await useTrackerStore.getState().getTimerState();
        if (isMountedRef.current) {
          setTimerState(state);
          const isRunning = state.state === 'RUNNING';
          const isPaused = state.state === 'PAUSED';
          const storeState = useTrackerStore.getState();
          // Clear error if Timer Engine was paused successfully despite API error
          const shouldClearError = isPaused && storeState.error?.includes('pause');
          useTrackerStore.setState({
            isTracking: isRunning || isPaused,
            isPaused: isPaused,
            ...(shouldClearError ? { error: null } : {}),
          });
        }
      } catch (syncError) {
        logger.warn('TIMER', 'Failed to sync timer state after pause error', syncError);
      }
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  const handleResume = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      // Pass fromIdleWindow=false but allow resume - this is explicit user action
      // The idlePauseStartTime check should not block explicit user actions
      await resumeTracking(false);
    } catch (error) {
      logger.error('TIMER', 'Failed to resume tracking', error);
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  const handleStop = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await stopTracking();
    } catch (error) {
      logger.error('TIMER', 'Failed to stop tracking', error);
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  // FIX: Use store state as fallback when Timer Engine is STOPPED but we have active entry from server
  // loadActiveTimeEntry is async — user may see Start before sync completes. Show Resume/Stop if store
  // has currentTimeEntry with isTracking (server had PAUSED/RUNNING entry).
  const effectiveState =
    effectiveTimerState?.state === 'RUNNING' || effectiveTimerState?.state === 'PAUSED'
      ? effectiveTimerState.state
      : currentTimeEntry && isTracking
        ? (isPaused ? 'PAUSED' as const : 'RUNNING' as const)
        : 'STOPPED';

  // Определяем состояние и цвета - macOS-style state-based colors (используем effectiveState)
  const timerStateInfo =
    effectiveState === 'RUNNING'
      ? {
          state: 'RUNNING' as const,
          color: 'text-timer-running dark:text-timer-running-dark',
          statusText: 'Tracking',
          statusColor: 'bg-timer-running dark:bg-timer-running-dark' as const,
        }
      : effectiveState === 'PAUSED'
        ? {
            state: 'PAUSED' as const,
            color: 'text-muted-foreground',
            statusText: idlePauseStartTime ? 'Paused (no activity)' : 'Paused',
            statusColor: 'bg-muted-foreground/40' as const,
          }
        : {
            state: 'STOPPED' as const,
            color: 'text-muted-foreground',
            statusText: 'Not started',
            statusColor: undefined as undefined,
          };

  // Тик каждую секунду при RUNNING — для интерполяции (таймер тикает сразу, не ждём push от Rust)
  const [, setTick] = useState(0);
  const rustElapsed = effectiveTimerState?.elapsed_seconds ?? 0;
  const wallElapsed = clientSessionStartMs != null
    ? Math.floor((Date.now() - clientSessionStartMs) / 1000)
    : 0;
  // Интерполяция: когда poll ещё не вернул RUNNING (оптимистичный старт) — показываем wallElapsed
  const useInterpolation =
    effectiveTimerState?.state === 'RUNNING' &&
    clientSessionStartMs != null &&
    pollStaleAfterStartResume;
  useEffect(() => {
    if (!useInterpolation) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [useInterpolation]);

  const elapsedSeconds = useInterpolation ? wallElapsed : rustElapsed;
  const totalTodaySeconds = effectiveTimerState?.today_seconds ?? elapsedSeconds;

  // FIX: Показываем таймер если есть active time entry, даже если selectedProject не установлен
  // Это исправляет ситуацию когда таймер работает, но UI показывает "No projects"
  if (!selectedProject && !currentTimeEntry) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 max-w-sm mx-auto">
        <div className="mb-6">
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-muted-foreground/40"
          >
            <circle cx="60" cy="60" r="50" stroke="currentColor" strokeWidth="2" opacity="0.5" />
            <circle cx="60" cy="60" r="4" fill="currentColor" opacity="0.6" />
            <line x1="60" y1="60" x2="60" y2="30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
            <line x1="60" y1="60" x2="82" y2="60" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
            <path d="M60 20 L60 24 M60 96 L60 100 M20 60 L24 60 M96 60 L100 60" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
          </svg>
        </div>
        <h3 className="text-base font-medium text-foreground mb-1.5">
          Ready to track time
        </h3>
        <p className="text-sm text-muted-foreground text-center mb-4">
          Select a project above to start the timer and begin tracking your work.
        </p>
        <p className="text-xs text-muted-foreground/70 text-center">
          Projects are loaded from your account. If the list is empty, check your project settings.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center space-y-4 py-4">
      {/* Error message - hide when offline + project selected + timer working (expected offline state) */}
      {error && !(!isOnline && (selectedProject || currentTimeEntry) && (effectiveTimerState?.state === 'RUNNING' || effectiveTimerState?.state === 'PAUSED')) && (
        <div className="w-full max-w-md p-3 rounded-lg bg-muted/50 border border-border animate-in fade-in flex gap-2">
          <AlertCircle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground mb-0.5">Something went wrong</div>
            <div className="text-sm text-muted-foreground">{error}</div>
            <p className="text-xs text-muted-foreground mt-2">You can try again or switch projects.</p>
          </div>
        </div>
      )}

      {/* Project badge - prominent when tracking */}
      {(selectedProject || currentTimeEntry?.project) && (
        <div className="w-full max-w-md flex justify-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
            style={{
              backgroundColor: (selectedProject?.color || currentTimeEntry?.project?.color || '#475569') + '20',
              color: selectedProject?.color || currentTimeEntry?.project?.color || '#475569',
            }}
          >
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor: selectedProject?.color || currentTimeEntry?.project?.color || '#475569',
            }}
            />
            <span className="truncate max-w-[200px]">
              {selectedProject?.name || currentTimeEntry?.project?.name || 'Project'}
            </span>
          </div>
        </div>
      )}

      {/* Уведомление при восстановлении RUNNING → PAUSED после перезапуска */}
      {effectiveTimerState?.state === 'PAUSED' && effectiveTimerState?.restored_from_running && (
        <div className="w-full max-w-md p-3 rounded-md bg-muted/50 border border-muted-foreground/20 text-center text-sm text-muted-foreground animate-in fade-in">
          Timer was paused after restarting the application. Click "Resume" to continue.
        </div>
      )}
      
      {/* Timer Display - Главный визуальный якорь */}
      <div className="flex flex-col items-center space-y-2">
        {/* Время - самый крупный элемент с state-based color transition */}
        <div className={cn(
          "text-6xl font-mono font-bold tracking-tight transition-colors duration-300",
          timerStateInfo.color
        )}>
          {formatTime(elapsedSeconds)}
        </div>
        
        {/* Idle time (если приостановлено из-за idle) */}
        {effectiveTimerState?.state === 'PAUSED' && idlePauseStartTime && (
          <div className="flex flex-col items-center space-y-1">
            <div className="text-xs text-muted-foreground font-medium">
              Idle:
            </div>
            <div className="text-2xl font-mono text-muted-foreground/80">
              {formatTime(idleTime)}
            </div>
          </div>
        )}
        
        {/* Статус и дневная сводка */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {effectiveTimerState && effectiveTimerState.state === 'RUNNING' && (
            <div className={cn(
              "w-2 h-2 rounded-full bg-timer-running dark:bg-timer-running-dark",
              "animate-pulse"
            )} />
          )}
          {effectiveTimerState && effectiveTimerState.state === 'PAUSED' && (
            <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
          )}
          {isTakingScreenshot && (
            <Camera className="w-3.5 h-3.5 text-primary animate-pulse" />
          )}
          <span>{timerStateInfo.statusText}</span>
          <span className="text-muted-foreground/70">•</span>
          <span>Today: {formatTimeShort(totalTodaySeconds)}</span>
        </div>
      </div>

      {/* Кнопки управления - macOS-style unified controls */}
      <div className="flex gap-2 justify-center">
        {(() => {
          if (effectiveState === 'STOPPED') {
            return (
              <Button
                onClick={handleStart}
                disabled={isLoading || isProcessing}
                size="lg"
                className="gap-2 px-6 h-10 text-sm rounded-md"
              >
                <Play className="h-4 w-4" />
                Start
              </Button>
            );
          }
          
          const currentState = effectiveState;
          
          return (
            <>
              {currentState === 'PAUSED' ? (
                <Button
                  onClick={handleResume}
                  disabled={isLoading || isProcessing}
                  size="lg"
                  variant="default"
                  className="gap-2 px-6 h-10 text-sm rounded-md"
                >
                  <RotateCcw className="h-4 w-4" />
                  Resume
                </Button>
              ) : (
                <Button
                  onClick={handlePause}
                  disabled={isLoading || isProcessing}
                  size="lg"
                  variant="default"
                  className="gap-2 px-6 h-10 text-sm rounded-md"
                >
                  <Pause className="h-4 w-4" />
                  Pause
                </Button>
              )}
              <Button
                onClick={handleStop}
                disabled={isLoading || isProcessing}
                size="lg"
                variant="outline"
                className="gap-2 px-6 h-10 text-sm rounded-md"
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            </>
          );
        })()}
      </div>

      {/* Pause state — encouraging message in free space */}
      {effectiveState === 'PAUSED' && (
        <div className="flex flex-col items-center gap-2 pt-20 text-muted-foreground">
          <Coffee className="h-40 w-40" style={{ color: '#ff9300' }} strokeWidth={2.25} />
          <span className="text-sm font-medium">Take a break and enjoy a cup of coffee!</span>
        </div>
      )}
    </div>
  );
}

// Компонент с таймером (скриншоты делаются автоматически, но не отображаются в UI)
export function TimerWithScreenshots() {
  return (
    <div className="space-y-6">
      <Timer />
      {/* Screenshots are captured automatically but not displayed in UI */}
    </div>
  );
}
