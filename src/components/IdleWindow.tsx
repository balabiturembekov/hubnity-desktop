import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Button } from './ui/button';
import { RotateCcw, Square } from 'lucide-react';
import { logger } from '../lib/logger';

function formatTime(seconds: number): string {
  const displaySeconds = Math.max(0, seconds);
  const hours = Math.floor(displaySeconds / 3600);
  const minutes = Math.floor((displaySeconds % 3600) / 60);
  const secs = displaySeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function IdleWindow() {
  const [idleTime, setIdleTime] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [idlePauseStartTime, setIdlePauseStartTime] = useState<number | null>(null);
  
  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Log when component mounts
  useEffect(() => {
    logger.debug('IDLE_WINDOW', 'Component mounted');
  }, []);

  // Listen for state updates from main window via Tauri events
  useEffect(() => {
    let isMounted = true;
    
    logger.debug('IDLE_WINDOW', 'Setting up event listeners...');
    let unlistenState: (() => void) | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    
    const MAX_IDLE_SECONDS = 24 * 60 * 60; // 24 hours = 86400 seconds
    
    const updateState = (pauseTime: number | null, loading: boolean) => {
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMounted) return;
      
      logger.debug('IDLE_WINDOW', 'Updating state', { pauseTime, isLoading: loading, pauseTimeType: typeof pauseTime });
      
      // Validate pauseTime before setting
      let validPauseTime: number | null = null;
      if (pauseTime !== null && pauseTime !== undefined) {
        const numValue = Number(pauseTime);
        if (!isNaN(numValue) && numValue > 0 && isFinite(numValue)) {
          validPauseTime = numValue;
          logger.debug('IDLE_WINDOW', `Valid pause time set: ${validPauseTime}`);
        } else {
          logger.warn('IDLE_WINDOW', `Invalid pause time: ${numValue} (isNaN: ${isNaN(numValue)}, isFinite: ${isFinite(numValue)})`);
        }
      }
      
      // Check again before setState
      if (!isMounted) return;
      
      setIdlePauseStartTime(validPauseTime);
      // Only set isLoading if it's actually a loading operation (not from screenshots)
      // Screenshots should not block buttons
      setIsLoading(loading);
      
      // Calculate initial time if we have pause start time
      if (validPauseTime !== null && validPauseTime > 0) {
        const now = Date.now();
        const idleSeconds = Math.floor((now - validPauseTime) / 1000);
        // Validate: ensure no NaN or negative values
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        // Reset to 0 after 24 hours
        const displaySeconds = validIdleSeconds >= MAX_IDLE_SECONDS ? 0 : validIdleSeconds;
        logger.debug('IDLE_WINDOW', `Calculated initial idle time: ${idleSeconds}s, displaying: ${displaySeconds}s (max 24h)`);
        setIdleTime(displaySeconds);
      } else {
        logger.debug('IDLE_WINDOW', 'No valid pause time, resetting idle time to 0');
        setIdleTime(0);
      }
    };
    
    const setupListener = async () => {
      try {
        logger.debug('IDLE_WINDOW', 'Setting up idle-state-update listener...');
        
        // Listen for state updates (pause start time, loading state)
        const unlistenStateFn = await listen<{ idlePauseStartTime: number | null; isLoading: boolean }>('idle-state-update', (event) => {
          logger.debug('IDLE_WINDOW', 'State update received', event.payload);
          
          // Handle null values correctly
          let pauseTime: number | null = null;
          const rawValue = event.payload.idlePauseStartTime;
          
          if (rawValue !== null && rawValue !== undefined) {
            const numValue = Number(rawValue);
            if (!isNaN(numValue) && numValue > 0 && isFinite(numValue)) {
              pauseTime = numValue;
              logger.debug('IDLE_WINDOW', `Valid pause time set: ${pauseTime}`);
            } else {
              logger.warn('IDLE_WINDOW', `Invalid pause time value: ${numValue}`);
            }
          }
          
          updateState(pauseTime, event.payload.isLoading);
        });
        unlistenState = unlistenStateFn;
        
        logger.debug('IDLE_WINDOW', 'State listener set up successfully');
        
        // Запрашиваем состояние у главного окна: несколько раз при открытии, затем редко
        const requestState = async () => {
          try {
            await invoke('request_idle_state');
          } catch (error) {
            logger.error('IDLE_WINDOW', 'Failed to request state', error);
          }
        };
        requestState();
        setTimeout(requestState, 500);
        setTimeout(requestState, 1500);
        // Дальше — раз в 10 с, без спама
        pollInterval = setInterval(requestState, 10000);
      } catch (error) {
        logger.error('IDLE_WINDOW', 'Failed to setup listener', error);
      }
    };
    
    setupListener();

    return () => {
      isMounted = false;
      logger.debug('IDLE_WINDOW', 'Cleaning up listeners...');
      if (unlistenState) unlistenState();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, []);

  // Local timer that updates every second if we have pause start time
  // Timer resets to 0 after 24 hours (86400 seconds)
  useEffect(() => {
    let isMounted = true;
    
    if (idlePauseStartTime !== null && idlePauseStartTime > 0 && !isNaN(idlePauseStartTime) && isFinite(idlePauseStartTime)) {
      const MAX_IDLE_SECONDS = 24 * 60 * 60; // 24 hours = 86400 seconds
      
      const updateTime = () => {
        // BUG FIX: Check if component is still mounted before updating state
        if (!isMounted) return;
        
        const now = Date.now();
        const idleSeconds = Math.floor((now - idlePauseStartTime) / 1000);
        
        // Validate: ensure no NaN or negative values
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        // Reset to 0 after 24 hours
        const displaySeconds = validIdleSeconds >= MAX_IDLE_SECONDS ? 0 : validIdleSeconds;
        
        setIdleTime(displaySeconds);
      };
      
      // Initial update immediately
      updateTime();
      
      // Update every second
      const interval = setInterval(() => {
        updateTime();
      }, 1000);
      
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
  }, [idlePauseStartTime]);
  
  const handleResume = async () => {
    if (isLoading) return;
    
    try {
      setIsLoading(true);
      await invoke('resume_tracking_from_idle');
      // Window will be closed automatically by main window
    } catch (error) {
      logger.error('IDLE_WINDOW', 'Failed to resume', error);
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsLoading(false);
      }
      try {
        await invoke('show_notification', {
          title: 'Error',
          body: 'Could not resume tracking',
        });
      } catch (notifError) {
        // Ignore notification errors
      }
    }
  };

  const handleStop = async () => {
    if (isLoading) return;
    
    try {
      setIsLoading(true);
      await invoke('stop_tracking_from_idle');
      // Window will be closed automatically by main window
    } catch (error) {
      logger.error('IDLE_WINDOW', 'Failed to stop', error);
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsLoading(false);
      }
      try {
        await invoke('show_notification', {
          title: 'Error',
          body: 'Could not stop tracking',
        });
      } catch (notifError) {
        // Ignore notification errors
      }
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col items-center justify-center px-5 py-6">
      <div className="flex flex-col items-center space-y-4 mb-6 flex-1 justify-center">
        <div className="text-5xl font-mono font-bold text-primary tracking-tight leading-none">
          {formatTime(idleTime)}
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
            <span>Paused (no activity)</span>
          </div>
          <span className="text-[11px] text-muted-foreground/50">
            Return to continue tracking
          </span>
        </div>
      </div>
      <div className="flex gap-2 w-full max-w-sm pb-2">
        <Button
          onClick={handleResume}
          disabled={isLoading}
          size="default"
          variant="default"
          className="gap-2 flex-1 h-10 text-sm rounded-md"
        >
          <RotateCcw className="h-4 w-4" />
          Resume
        </Button>
        <Button
          onClick={handleStop}
          disabled={isLoading}
          size="default"
          variant="outline"
          className="gap-2 h-10 px-4 text-sm rounded-md"
        >
          <Square className="h-4 w-4" />
          Stop
        </Button>
      </div>
      {import.meta.env.DEV && idlePauseStartTime && (
        <div className="mt-3 text-[10px] text-muted-foreground/40 font-mono max-w-md break-all text-center">
          pauseStart: {new Date(idlePauseStartTime).toLocaleTimeString()}, diff:{' '}
          {Math.floor((Date.now() - idlePauseStartTime) / 1000)}s
        </div>
      )}
    </div>
  );
}
