import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { useTrackerStore, type TimerStateResponse } from '../store/useTrackerStore';
import { Play, Pause, Square, RotateCcw, Camera } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ScreenshotsView } from './ScreenshotsView';
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
    const updateTimerState = async () => {
      try {
        const state = await useTrackerStore.getState().getTimerState();
        setTimerState(state);
        
        const isRunning = state.state === 'RUNNING';
        const isPaused = state.state === 'PAUSED';
        
        const { isTracking: currentIsTracking, isPaused: currentIsPaused } = useTrackerStore.getState();
        if (currentIsTracking !== isRunning || currentIsPaused !== isPaused) {
          useTrackerStore.setState({
            isTracking: isRunning || isPaused,
            isPaused: isPaused,
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
        }).catch(() => {
          // Silently fail if tray is not available
        });
      } catch (error) {
        logger.error('TIMER', 'Failed to get timer state', error);
      }
    };

    updateTimerState();
    const interval = setInterval(updateTimerState, 1000);
    return () => clearInterval(interval);
  }, []);

  // Проверка смены дня
  useEffect(() => {
    const checkDayChange = async () => {
      if (!timerState?.day_start) return;
      
      const dayStartTimestamp = timerState.day_start;
      const today = new Date();
      const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const dayStartDateUTC = new Date(dayStartTimestamp * 1000);
      const dayStartUTC = new Date(Date.UTC(dayStartDateUTC.getUTCFullYear(), dayStartDateUTC.getUTCMonth(), dayStartDateUTC.getUTCDate()));
      
      const isDifferentDay = todayUTC.getTime() !== dayStartUTC.getTime();
      
      if (isDifferentDay) {
        try {
          const newState = await useTrackerStore.getState().resetDay();
          setTimerState(newState);
        } catch (error) {
          logger.error('TIMER', 'Failed to reset day', error);
        }
      }
    };

    const dayCheckInterval = setInterval(checkDayChange, 60000);
    checkDayChange();
    return () => clearInterval(dayCheckInterval);
  }, [timerState?.day_start]);

  // Обновление idle time
  useEffect(() => {
    if (timerState?.state === 'PAUSED' && idlePauseStartTime) {
      const updateIdleTime = () => {
        const now = Date.now();
        const idleSeconds = Math.floor((now - idlePauseStartTime) / 1000);
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        setIdleTime(validIdleSeconds);
      };
      
      updateIdleTime();
      const interval = setInterval(updateIdleTime, 1000);
      return () => clearInterval(interval);
    } else {
      setIdleTime(0);
    }
  }, [timerState?.state, idlePauseStartTime]);

  const handleStart = async () => {
    if (!selectedProject || isProcessing) return;
    setIsProcessing(true);
    try {
      await startTracking();
    } catch (error: any) {
      // Error is already set in store
    } finally {
      setIsProcessing(false);
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
      setIsProcessing(false);
    }
  };

  const handleResume = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await resumeTracking();
    } catch (error) {
      logger.error('TIMER', 'Failed to resume tracking', error);
    } finally {
      setIsProcessing(false);
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
      setIsProcessing(false);
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
        statusText: 'Отслеживается',
        statusColor: 'bg-timer-running dark:bg-timer-running-dark',
      };
    }
    if (currentState === 'PAUSED') {
      return {
        state: 'PAUSED' as const,
        color: 'text-muted-foreground',
        statusText: idlePauseStartTime ? 'Приостановлено (нет активности)' : 'Приостановлено',
        statusColor: 'bg-muted-foreground/40',
      };
    }
    return {
      state: 'STOPPED' as const,
      color: 'text-muted-foreground',
      statusText: 'Не запущено',
      statusColor: undefined,
    };
  };

  const timerStateInfo = getTimerState();
  const elapsedSeconds = timerState?.elapsed_seconds ?? 0;

  if (!selectedProject) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <p className="text-sm text-muted-foreground text-center">
          Выберите проект для начала отслеживания
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center space-y-6 py-8">
      {/* Error message */}
      {error && (
        <div className="w-full max-w-md p-3 rounded-md bg-destructive/10 border border-destructive/20 animate-in fade-in">
          <div className="text-xs font-medium text-destructive mb-0.5">Ошибка</div>
          <div className="text-xs text-destructive/80">{error}</div>
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
                Старт
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
                  Возобновить
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
                  Пауза
                </Button>
              )}
              <Button
                onClick={handleStop}
                disabled={isLoading || isProcessing}
                size="lg"
                className="gap-2 px-6 h-10 text-sm rounded-md bg-destructive-soft hover:bg-destructive-softHover text-white"
              >
                <Square className="h-4 w-4" />
                Стоп
              </Button>
            </>
          );
        })()}
      </div>
    </div>
  );
}

// Компонент с таймером и скриншотами
export function TimerWithScreenshots() {
  const { currentTimeEntry } = useTrackerStore();

  return (
    <div className="space-y-6">
      <Timer />
      {currentTimeEntry?.id && (
        <ScreenshotsView timeEntryId={currentTimeEntry.id} />
      )}
    </div>
  );
}
