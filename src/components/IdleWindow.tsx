import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Button } from './ui/button';
import { RotateCcw, Square } from 'lucide-react';
import { logger } from '../lib/logger';

/**
 * Hubstaff-style idle time format:
 * - Under 1 hour: minutes (e.g. "11 minutes")
 * - 1–24 hours: hours and minutes (e.g. "1 hour 30 minutes")
 * - Over 24 hours: days and hours (e.g. "2 days 16 hours")
 * No seconds — less distracting.
 */
function formatIdleTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalSeconds / 3600);
  const days = Math.floor(totalSeconds / 86400);

  if (days >= 1) {
    const remainingHours = Math.floor((totalSeconds % 86400) / 3600);
    if (remainingHours === 0) {
      return days === 1 ? '1 day' : `${days} days`;
    }
    return days === 1
      ? `1 day ${remainingHours} ${remainingHours === 1 ? 'hour' : 'hours'}`
      : `${days} days ${remainingHours} ${remainingHours === 1 ? 'hour' : 'hours'}`;
  }
  if (totalHours >= 1) {
    const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
    if (remainingMinutes === 0) {
      return totalHours === 1 ? '1 hour' : `${totalHours} hours`;
    }
    const h = totalHours === 1 ? '1 hour' : `${totalHours} hours`;
    const m = remainingMinutes === 1 ? '1 minute' : `${remainingMinutes} minutes`;
    return `${h} ${m}`;
  }
  return totalMinutes === 1 ? '1 minute' : `${totalMinutes} minutes`;
}

export function IdleWindow() {
  const [idleTime, setIdleTime] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [idlePauseStartTime, setIdlePauseStartTime] = useState<number | null>(null);
  const [idlePauseStartPerfRef, setIdlePauseStartPerfRef] = useState<number | null>(null);
  const [lastActivityTime, setLastActivityTime] = useState<number | null>(null);
  const [lastActivityPerfRef, setLastActivityPerfRef] = useState<number | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  
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
  const unlistenRef = useRef<(() => void) | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let isMounted = true;
    cancelledRef.current = false;
    
    logger.debug('IDLE_WINDOW', 'Setting up event listeners...');
    
    const MAX_IDLE_SECONDS = 24 * 60 * 60; // 24 hours = 86400 seconds
    
    const updateState = (
      pauseTime: number | null,
      pausePerfRef: number | null,
      loading: boolean,
      lastActivity: number | null,
      lastActivityPerf: number | null,
      project: string | null
    ) => {
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMounted) return;
      
      logger.debug('IDLE_WINDOW', 'Updating state', { pauseTime, lastActivity, isLoading: loading, pauseTimeType: typeof pauseTime });
      
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
      
      // Validate lastActivityTime for total idle display (Hubstaff-style)
      let validLastActivity: number | null = null;
      if (lastActivity !== null && lastActivity !== undefined) {
        const numValue = Number(lastActivity);
        if (!isNaN(numValue) && numValue > 0 && isFinite(numValue)) {
          validLastActivity = numValue;
        }
      }
      
      // Check again before setState
      if (!isMounted) return;
      
      setIdlePauseStartTime(validPauseTime);
      setIdlePauseStartPerfRef(pausePerfRef);
      setLastActivityTime(validLastActivity);
      setLastActivityPerfRef(lastActivityPerf);
      setProjectName(project ?? null);
      setIsLoading(loading);
      
      // performance.now() для монотонного elapsed (не прыгает при NTP)
      const basePerfRef = lastActivityPerf ?? pausePerfRef;
      if (basePerfRef !== null && basePerfRef > 0) {
        const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const idleSeconds = Math.floor((perfNow - basePerfRef) / 1000);
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        const displaySeconds = validIdleSeconds >= MAX_IDLE_SECONDS ? 0 : validIdleSeconds;
        setIdleTime(displaySeconds);
      } else if (validLastActivity ?? validPauseTime) {
        // Fallback: baseTime без perfRef — используем Date.now()
        const baseTime = validLastActivity ?? validPauseTime!;
        const now = Date.now();
        const idleSeconds = Math.floor((now - baseTime) / 1000);
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        const displaySeconds = validIdleSeconds >= MAX_IDLE_SECONDS ? 0 : validIdleSeconds;
        setIdleTime(displaySeconds);
      } else {
        logger.debug('IDLE_WINDOW', 'No valid base time, resetting idle time to 0');
        setIdleTime(0);
      }
    };
    
    const setupListener = async () => {
      try {
        logger.debug('IDLE_WINDOW', 'Setting up idle-state-update listener...');
        
        // Listen for state updates (pause start time, last activity time, loading state, project name)
        const unlistenStateFn = await listen<{
          idlePauseStartTime: number | null;
          idlePauseStartPerfRef?: number | null;
          lastActivityTime?: number | null;
          lastActivityPerfRef?: number | null;
          isLoading: boolean;
          projectName?: string | null;
        }>('idle-state-update', (event) => {
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
          
          let lastActivity: number | null = null;
          const rawLastActivity = event.payload.lastActivityTime;
          if (rawLastActivity !== null && rawLastActivity !== undefined) {
            const numValue = Number(rawLastActivity);
            if (!isNaN(numValue) && numValue > 0 && isFinite(numValue)) {
              lastActivity = numValue;
            }
          }
          const pausePerfRef = event.payload.idlePauseStartPerfRef != null && !isNaN(Number(event.payload.idlePauseStartPerfRef))
            ? Number(event.payload.idlePauseStartPerfRef) : null;
          const lastActivityPerf = event.payload.lastActivityPerfRef != null && !isNaN(Number(event.payload.lastActivityPerfRef))
            ? Number(event.payload.lastActivityPerfRef) : null;
          const project = typeof event.payload.projectName === 'string' ? event.payload.projectName : null;
          updateState(pauseTime, pausePerfRef, event.payload.isLoading, lastActivity, lastActivityPerf, project);
        });
        
        // FIX: If unmounted while listen() was pending, clean up immediately
        if (cancelledRef.current) {
          unlistenStateFn();
          return;
        }
        unlistenRef.current = unlistenStateFn;
        
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
        if (cancelledRef.current) return;
        pollIntervalRef.current = setInterval(requestState, 10000);
      } catch (error) {
        logger.error('IDLE_WINDOW', 'Failed to setup listener', error);
      }
    };
    
    setupListener();

    return () => {
      isMounted = false;
      cancelledRef.current = true;
      logger.debug('IDLE_WINDOW', 'Cleaning up listeners...');
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  // Local timer: performance.now() для монотонного elapsed (не прыгает при NTP)
  const basePerfRef = lastActivityPerfRef ?? idlePauseStartPerfRef;
  const hasBase = (lastActivityTime ?? idlePauseStartTime) && basePerfRef;
  useEffect(() => {
    let isMounted = true;
    
    if (hasBase && basePerfRef) {
      const MAX_IDLE_SECONDS = 24 * 60 * 60; // 24 hours = 86400 seconds
      
      const updateTime = () => {
        if (!isMounted) return;
        const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const idleSeconds = Math.floor((perfNow - basePerfRef) / 1000);
        
        // Validate: ensure no NaN or negative values
        const validIdleSeconds = isNaN(idleSeconds) ? 0 : Math.max(0, idleSeconds);
        // Reset to 0 after 24 hours
        const displaySeconds = validIdleSeconds >= MAX_IDLE_SECONDS ? 0 : validIdleSeconds;
        
        setIdleTime(displaySeconds);
      };
      
      // Initial update immediately
      updateTime();
      
      // Update every minute — no seconds shown, so no need for 1s tick
      const interval = setInterval(() => {
        updateTime();
      }, 60_000);
      
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
  }, [basePerfRef, hasBase]);
  
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
    <div className="h-screen w-screen bg-background flex flex-col items-center justify-center px-6 py-6 rounded-2xl overflow-hidden">
      {/* Hubstaff-style layout — header is draggable (no decorations) */}
      <div data-tauri-drag-region className="cursor-grab active:cursor-grabbing -mx-6 -mt-6 px-6 pt-6 pb-2 mb-2">
        <h2 className="text-lg font-semibold text-foreground">Idle time alert</h2>
      </div>
      
      <div className="w-full max-w-sm rounded-lg bg-muted/50 border border-border p-4 mb-6">
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          You have been idle for
        </div>
        <div className="text-3xl font-bold text-foreground mb-3">
          {formatIdleTime(idleTime)}
        </div>
        <div className="border-t border-border pt-3 flex justify-between items-start gap-4">
          <div className="space-y-1 text-sm text-muted-foreground">
            <div>Project: {projectName || '-'}</div>
            <div>Task: -</div>
          </div>
          <button
            type="button"
            className="text-sm text-primary hover:underline shrink-0"
            onClick={async () => {
              try {
                await invoke('show_notification', {
                  title: 'Reassign time',
                  body: 'Coming soon',
                });
              } catch {}
            }}
          >
            Reassign time
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-6 text-center">
        Idle time is not included in the tracked duration.
      </p>

      <div className="flex gap-2 w-full max-w-sm">
        <Button
          onClick={handleStop}
          disabled={isLoading}
          size="default"
          variant="outline"
          className="gap-2 flex-1 h-10 text-sm rounded-md"
        >
          <Square className="h-4 w-4" />
          Stop timer
        </Button>
        <Button
          onClick={handleResume}
          disabled={isLoading}
          size="default"
          variant="default"
          className="gap-2 flex-1 h-10 text-sm rounded-md"
        >
          <RotateCcw className="h-4 w-4" />
          Resume timer
        </Button>
      </div>
    </div>
  );
}
