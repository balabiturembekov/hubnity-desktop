import { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { useTrackerStore, type TimerStateResponse } from '../store/useTrackerStore';
import { useSyncStore } from '../store/useSyncStore';
import { Play, Pause, Square, RotateCcw, Camera, AlertCircle, Coffee } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
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
    lastActivityTime,
    lastTimerStateFromStart,
    clientSessionStartMs,
  } = useTrackerStore();
  const isOnline = useSyncStore((s) => s.status?.is_online ?? true);

  // Состояние таймера из Rust (единственный source of truth).
  // lastTimerStateFromStart — сразу после start/resume, session_start от Rust.
  const [timerState, setTimerState] = useState<TimerStateResponse | null>(null);
  const effectiveTimerState = timerState ?? lastTimerStateFromStart;
  const [idleTime, setIdleTime] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // Получаем состояние таймера из Rust. Stack Overflow / MDN: setInterval неточен,
  // опрос каждые 200ms + Date.now() на бэкенде даёт стабильную синхронизацию с системными часами.
  const POLL_MS = 200;
  useEffect(() => {
    let isMounted = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        if (!isMounted) return;
        updateTimerState();
        scheduleNext();
      }, POLL_MS);
    };

    const updateTimerState = async () => {
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMounted) return;
      
      try {
        const state = await useTrackerStore.getState().getTimerState();
        
        // Check again after async operation
        if (!isMounted) return;
        
        setTimerState(state);
        
        const isRunning = state.state === 'RUNNING';
        const isPaused = state.state === 'PAUSED';
        
        const store = useTrackerStore.getState();
        const { isTracking: currentIsTracking, isPaused: currentIsPaused, currentTimeEntry } = store;
        
        // BUG FIX: Always update store if state changed, even if isLoading is true
        // This prevents store from being stale when isLoading gets stuck or operations complete
        // The isLoading check was preventing sync when operations finished but isLoading wasn't cleared
        const trackingChanged = currentIsTracking !== (isRunning || isPaused) || currentIsPaused !== isPaused;
        const needClearEntry = state.state === 'STOPPED' && currentTimeEntry !== null;
        if (trackingChanged || needClearEntry) {
          useTrackerStore.setState({
            isTracking: isRunning || isPaused,
            isPaused: isPaused,
            ...(state.state === 'STOPPED'
              ? { currentTimeEntry: null, idlePauseStartTime: null, lastResumeTime: null, localTimerStartTime: null }
              : state.state === 'RUNNING'
                ? { idlePauseStartTime: null } // FIX: Clear idle — Timer Engine RUNNING means we're not idle
                : {}),
          });
          // FIX: Hide idle window when Timer Engine is RUNNING or STOPPED — store/UI must stay in sync
          if (state.state === 'RUNNING' || state.state === 'STOPPED') {
            invoke('hide_idle_window').catch(() => {});
          }
          if (state.state === 'RUNNING') {
            invoke('start_activity_monitoring').catch(() => {}); // FIX: Sync to RUNNING — ensure monitoring
          }
          // BUG FIX: Timer Engine RUNNING/PAUSED but currentTimeEntry null — restore from server
          if ((isRunning || isPaused) && !currentTimeEntry) {
            useTrackerStore.getState().loadActiveTimeEntry().catch((e) => {
              logger.debug('TIMER', 'loadActiveTimeEntry failed (non-critical)', e);
            });
          }
        }
        
        // Обновляем tray tooltip — session_start_ms (Rust) точнее session_start (секунды)
        let tooltip = '⏹ 00:00:00';
        if (state.state === 'RUNNING') {
          const store = useTrackerStore.getState();
          const sessionStartMs = state.session_start_ms ?? store.clientSessionStartMs ?? (state.session_start != null ? state.session_start * 1000 : 0);
          const sessionStartSec = sessionStartMs / 1000;
          if (sessionStartSec > 0) {
            const acc = state.accumulated_seconds ?? 0;
            const nowSec = Date.now() / 1000;
            const elapsed = acc + Math.floor(Math.max(0, nowSec - sessionStartSec));
            tooltip = `▶ ${formatTime(elapsed)}`;
          } else {
            tooltip = `▶ ${formatTime(state.elapsed_seconds)}`;
          }
        } else if (state.state === 'PAUSED') {
          tooltip = `⏸ ${formatTime(state.elapsed_seconds)}`;
        }
        
        invoke('plugin:tray|set_tooltip', {
          id: 'main',
          tooltip,
        }).catch((error) => {
          // BUG FIX: Log error instead of silently ignoring (tray might not be available, but log for debugging)
          logger.debug('TIMER', 'Failed to set tray tooltip (non-critical)', error);
        });
      } catch (error) {
        logger.error('TIMER', 'Failed to get timer state', error);
      }
    };

    updateTimerState();
    scheduleNext();
    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
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

  // Обновление idle time — используем lastActivityTime (общее время простоя) когда есть, иначе idlePauseStartTime
  const idleBaseTime = lastActivityTime ?? idlePauseStartTime;
  useEffect(() => {
    let isMounted = true;
    
    if (effectiveTimerState?.state === 'PAUSED' && idleBaseTime) {
      const updateIdleTime = () => {
        // BUG FIX: Check if component is still mounted before updating state
        if (!isMounted) return;
        
        const now = Date.now();
        const idleSeconds = Math.floor((now - idleBaseTime) / 1000);
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
  }, [effectiveTimerState?.state, idleBaseTime]);

  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);
  
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

  // Для RUNNING: считаем на фронте через Date.now(). session_start_ms (Rust) — точная синхронизация.
  // Self-adjusting setTimeout (Stack Overflow): компенсирует drift.
  const TICK_MS = 100;
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const sessionStartMs = effectiveTimerState?.state === 'RUNNING'
    ? (effectiveTimerState.session_start_ms ?? clientSessionStartMs ?? (effectiveTimerState.session_start != null ? effectiveTimerState.session_start * 1000 : 0))
    : 0;
  useEffect(() => {
    const s = effectiveTimerState;
    if (!s || s.state !== 'RUNNING') {
      setDisplaySeconds(s?.elapsed_seconds ?? 0);
      return;
    }
    const acc = s.accumulated_seconds ?? 0;
    const sessionStartSec = sessionStartMs / 1000;
    if (sessionStartSec === 0) {
      setDisplaySeconds(s.elapsed_seconds);
      return;
    }
    let expected = Date.now();
    let timeoutId: ReturnType<typeof setTimeout>;
    const step = () => {
      const nowSec = Date.now() / 1000;
      const sessionElapsed = Math.max(0, nowSec - sessionStartSec);
      const computed = acc + Math.floor(sessionElapsed);
      setDisplaySeconds(Math.max(acc, computed));
      const drift = Date.now() - expected;
      expected += TICK_MS;
      timeoutId = setTimeout(step, Math.max(0, TICK_MS - drift));
    };
    step();
    return () => clearTimeout(timeoutId);
  }, [effectiveTimerState?.state, effectiveTimerState?.session_start, effectiveTimerState?.session_start_ms, effectiveTimerState?.accumulated_seconds, effectiveTimerState?.elapsed_seconds, clientSessionStartMs, sessionStartMs]);

  const useClientDisplay =
    effectiveTimerState?.state === 'RUNNING' &&
    (sessionStartMs > 0 || clientSessionStartMs != null || effectiveTimerState?.session_start != null);
  const elapsedSeconds = useClientDisplay ? displaySeconds : (effectiveTimerState?.elapsed_seconds ?? 0);
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
