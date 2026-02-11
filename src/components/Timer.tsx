import { useEffect, useState, useRef } from 'react';
import { Button } from './ui/button';
import { useTrackerStore, type TimerStateResponse } from '../store/useTrackerStore';
import { Play, Pause, Square, RotateCcw, Camera } from 'lucide-react';
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

export function Timer() {
  const {
    selectedProject,
    startTracking,
    pauseTracking,
    resumeTracking,
    stopTracking,
    isLoading,
    error,
    isTakingScreenshot,
    idlePauseStartTime,
  } = useTrackerStore();

  // Состояние таймера из Rust (единственный source of truth)
  const [timerState, setTimerState] = useState<TimerStateResponse | null>(null);
  const [idleTime, setIdleTime] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // Получаем состояние таймера из Rust каждую секунду
  useEffect(() => {
    let isMounted = true;
    
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
        const { isTracking: currentIsTracking, isPaused: currentIsPaused, currentTimeEntry, isLoading } = store;
        
        // BUG FIX: Don't update store if an operation is in progress to prevent race conditions
        // Operations like startTracking/pauseTracking set isLoading and update state themselves
        if (isLoading) {
          return; // Skip update during operations to prevent conflicts
        }
        
        const trackingChanged = currentIsTracking !== isRunning || currentIsPaused !== isPaused;
        const needClearEntry = state.state === 'STOPPED' && currentTimeEntry !== null;
        if (trackingChanged || needClearEntry) {
          useTrackerStore.setState({
            isTracking: isRunning || isPaused,
            isPaused: isPaused,
            ...(state.state === 'STOPPED' ? { currentTimeEntry: null } : {}),
          });
        }
        
        // Обновляем tray tooltip
        let tooltip = '⏹ 00:00:00';
        if (state.state === 'RUNNING') {
          tooltip = `▶ ${formatTime(state.elapsed_seconds)}`;
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
    const interval = setInterval(updateTimerState, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Проверка смены дня (локальная дата — как в Rust ensure_correct_day)
  useEffect(() => {
    let isMounted = true;
    
    const checkDayChange = async () => {
      if (!timerState?.day_start || !isMounted) return;

      const dayStartTimestamp = timerState.day_start;
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
  }, [timerState?.day_start]);

  // Обновление idle time
  useEffect(() => {
    let isMounted = true;
    
    if (timerState?.state === 'PAUSED' && idlePauseStartTime) {
      const updateIdleTime = () => {
        // BUG FIX: Check if component is still mounted before updating state
        if (!isMounted) return;
        
        const now = Date.now();
        const idleSeconds = Math.floor((now - idlePauseStartTime) / 1000);
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
  }, [timerState?.state, idlePauseStartTime]);

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
    } catch (error) {
      logger.error('TIMER', 'Failed to pause tracking', error);
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

  // Определяем состояние и цвета - macOS-style state-based colors
  const getTimerState = () => {
    if (!timerState) {
      return { 
        state: 'STOPPED' as const, 
        color: 'text-muted-foreground', 
        statusText: 'Не запущено',
        statusColor: undefined,
      };
    }
    
    const currentState = timerState.state;
    if (currentState === 'RUNNING') {
      return {
        state: 'RUNNING' as const,
        color: 'text-timer-running dark:text-timer-running-dark',
        statusText: 'Tracking',
        statusColor: 'bg-timer-running dark:bg-timer-running-dark',
      };
    }
    if (currentState === 'PAUSED') {
      return {
        state: 'PAUSED' as const,
        color: 'text-muted-foreground',
        statusText: idlePauseStartTime ? 'Paused (no activity)' : 'Paused',
        statusColor: 'bg-muted-foreground/40',
      };
    }
    return {
      state: 'STOPPED' as const,
      color: 'text-muted-foreground',
      statusText: 'Not started',
      statusColor: undefined,
    };
  };

  const timerStateInfo = getTimerState();
  const elapsedSeconds = timerState?.elapsed_seconds ?? 0;
  const { currentTimeEntry } = useTrackerStore();

  // FIX: Показываем таймер если есть active time entry, даже если selectedProject не установлен
  // Это исправляет ситуацию когда таймер работает, но UI показывает "No projects"
  if (!selectedProject && !currentTimeEntry) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <p className="text-sm text-muted-foreground text-center">
          Choose a project to start tracking
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center space-y-6 py-8">
      {/* Error message */}
      {error && (
        <div className="w-full max-w-md p-3 rounded-md bg-destructive/10 border border-destructive/20 animate-in fade-in">
          <div className="text-xs font-medium text-destructive mb-0.5">Error</div>
          <div className="text-xs text-destructive/80">{error}</div>
        </div>
      )}

      {/* Этап 4: уведомление при восстановлении RUNNING → PAUSED после перезапуска */}
      {timerState?.state === 'PAUSED' && timerState?.restored_from_running && (
        <div className="w-full max-w-md p-3 rounded-md bg-muted/50 border border-muted-foreground/20 text-center text-sm text-muted-foreground animate-in fade-in">
          Timer was paused after restarting the application. Click "Resume" to continue.
        </div>
      )}
      
      {/* Timer Display - Главный визуальный якорь */}
      <div className="flex flex-col items-center space-y-3">
        {/* Время - самый крупный элемент с state-based color transition */}
        <div className={cn(
          "text-6xl font-mono font-bold tracking-tight transition-colors duration-300",
          timerStateInfo.color
        )}>
          {formatTime(elapsedSeconds)}
        </div>
        
        {/* Idle time (если приостановлено из-за idle) */}
        {timerState?.state === 'PAUSED' && idlePauseStartTime && (
          <div className="flex flex-col items-center space-y-1">
            <div className="text-xs text-muted-foreground font-medium">
              Простой:
            </div>
            <div className="text-2xl font-mono text-muted-foreground/80">
              {formatTime(idleTime)}
            </div>
          </div>
        )}
        
        {/* Статус - визуально связан с временем */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {timerState && timerState.state === 'RUNNING' && (
            <div className={cn(
              "w-2 h-2 rounded-full bg-timer-running dark:bg-timer-running-dark",
              "animate-pulse"
            )} />
          )}
          {timerState && timerState.state === 'PAUSED' && (
            <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
          )}
          {isTakingScreenshot && (
            <Camera className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
          )}
          <span>{timerStateInfo.statusText}</span>
        </div>
      </div>

      {/* Кнопки управления - macOS-style unified controls */}
      <div className="flex gap-2.5 justify-center">
        {(() => {
          if (!timerState || timerState.state === 'STOPPED') {
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
          
          const currentState = timerState.state;
          
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
                className="gap-2 px-6 h-10 text-sm rounded-md bg-destructive-soft hover:bg-destructive-softHover text-white"
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            </>
          );
        })()}
      </div>
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
