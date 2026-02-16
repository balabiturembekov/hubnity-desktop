import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { useTrackerStore } from '../store/useTrackerStore';
import { Button } from './ui/button';
import { LogOut, Check, RefreshCw, Database } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { logger } from '../lib/logger';
import { api, USER_ROLES } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';

interface QueueStats {
  pending_count: number;
  failed_count: number;
  sent_count: number;
  pending_by_type: Record<string, number>;
}

export function Settings() {
  const { idleThreshold, setIdleThreshold } = useTrackerStore();
  const { logout, user } = useAuthStore();
  const [threshold, setThreshold] = useState(idleThreshold);
  const [sleepGapThreshold, setSleepGapThreshold] = useState(5);
  const [loadedSleepGap, setLoadedSleepGap] = useState(5);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  
  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  // Проверка прав доступа: только owner или admin могут видеть настройки
  // Используем константы USER_ROLES для проверки (case-sensitive, как приходит с сервера)
  const hasAccess = user && (user.role === USER_ROLES.OWNER || user.role === USER_ROLES.ADMIN);

  if (!hasAccess) {
    return (
      <div className="space-y-3">
        <Card className="border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              You do not have access to settings. Access is granted only to owners and administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Sync local state with store when idleThreshold changes
  useEffect(() => {
    setThreshold(idleThreshold);
  }, [idleThreshold]);

  // Загрузить статистику очереди; при нажатии «Обновить» — восстановить токены и запустить синхронизацию
  const loadQueueStats = async (runSync = false) => {
    // BUG FIX: Check if component is still mounted before updating state
    if (!isMountedRef.current) return;
    
    setIsLoadingStats(true);
    try {
      // set_auth_tokens только при runSync — иначе спам в логах каждые 10 сек
      // get_sync_queue_stats читает из локальной БД, токены не нужны
      if (runSync) {
        const accessToken = api.getAccessToken() || localStorage.getItem('access_token');
        const refreshToken = localStorage.getItem('refresh_token');
        if (accessToken) {
          const user = useAuthStore.getState().user;
          await invoke('set_auth_tokens', {
            accessToken,
            refreshToken,
            userId: user ? String(user.id) : null,
          });
          try {
            const synced = await invoke<number>('sync_queue_now');
            if (synced > 0) {
              logger.info('SETTINGS', `Synced ${synced} task(s)`);
            }
          } catch (e) {
            logger.warn('SETTINGS', 'sync_queue_now failed', e);
          }
        } else {
          logger.warn('SETTINGS', 'No access_token — sync skipped');
        }
      }
      const stats = await invoke<QueueStats>('get_sync_queue_stats');
      
      // BUG FIX: Check again after async operations
      if (!isMountedRef.current) return;
      
      setQueueStats(stats);
    } catch (error) {
      logger.error('SETTINGS', 'Failed to load queue stats', error);
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsLoadingStats(false);
      }
    }
  };

  useEffect(() => {
    loadQueueStats();
    // Refresh every 10 seconds
    const interval = setInterval(loadQueueStats, 10000);
    return () => clearInterval(interval);
  }, []);

  // Load sleep gap threshold on mount
  useEffect(() => {
    invoke<number>('get_sleep_gap_threshold_minutes')
      .then((m) => {
        if (isMountedRef.current) {
          setSleepGapThreshold(m);
          setLoadedSleepGap(m);
        }
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!isMountedRef.current) return;
    
    setIsSaving(true);
    setSaved(false);
    
    try {
      // Validate threshold (must be at least 1 minute)
      const validThreshold = Math.max(1, Math.floor(threshold));
      setThreshold(validThreshold);
      setIdleThreshold(validThreshold);
      
      const validSleepGap = Math.max(1, Math.min(120, Math.floor(sleepGapThreshold)));
      setSleepGapThreshold(validSleepGap);
      setLoadedSleepGap(validSleepGap);
      await invoke('set_sleep_gap_threshold_minutes', { minutes: validSleepGap });
      
      // Log for debugging
      await logger.safeLogToRust(`[SETTINGS] Idle: ${validThreshold} min, sleep gap: ${validSleepGap} min`).catch((e) => {
        logger.debug('SETTINGS', 'Failed to log (non-critical)', e);
      });
      
      // Show notification
      await invoke('show_notification', {
        title: 'Settings saved',
        body: `Idle: ${validThreshold} min, sleep detection: ${validSleepGap} min`,
      }).catch((e) => {
        logger.warn('SETTINGS', 'Failed to show notification (non-critical)', e);
      });
      
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMountedRef.current) return;
      
      setSaved(true);
      // Hide saved indicator after 2 seconds
      setTimeout(() => {
        // BUG FIX: Check if component is still mounted before updating state
        if (isMountedRef.current) {
          setSaved(false);
        }
      }, 2000);
    } catch (error) {
      logger.error('SETTINGS', 'Failed to save settings', error);
      await invoke('show_notification', {
        title: 'Error',
        body: 'Could not save settings',
      }).catch((e) => {
        logger.warn('SETTINGS', 'Failed to show error notification (non-critical)', e);
      });
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  return (
    <div className="space-y-4 max-w-md">
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium text-foreground">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0 px-4 pb-4">
          <div className="space-y-2">
            <Label htmlFor="idle-threshold" className="text-sm text-foreground">
              Idle threshold (min)
            </Label>
            <div className="flex gap-2">
              <Input
                id="idle-threshold"
                type="number"
                min="1"
                value={threshold}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setThreshold(Math.max(1, value || 1));
                  setSaved(false); // Reset saved indicator when value changes
                }}
                className="h-9"
                disabled={isSaving}
              />
              <Button 
                onClick={handleSave} 
                size="default" 
                className="h-9 px-4"
                disabled={isSaving || (threshold === idleThreshold && sleepGapThreshold === loadedSleepGap)}
              >
                {isSaving ? (
                  'Saving...'
                ) : saved ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Saved
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Auto-pause after {idleThreshold} {idleThreshold === 1 ? 'minute' : 'minutes'} of inactivity
            </p>
          </div>
          <div className="space-y-2 pt-2 border-t">
            <Label htmlFor="sleep-gap" className="text-sm text-foreground">
              Sleep detection threshold (min)
            </Label>
            <div className="flex gap-2">
              <Input
                id="sleep-gap"
                type="number"
                min="1"
                max="120"
                value={sleepGapThreshold}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setSleepGapThreshold(Math.max(1, Math.min(120, value || 1)));
                  setSaved(false);
                }}
                className="h-9"
                disabled={isSaving}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Pause timer when system sleep gap exceeds {sleepGapThreshold} min (1–120)
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium text-foreground">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0 px-4 pb-4">
          {user && (
            <div className="space-y-2.5">
              <div>
                <Label className="text-xs text-muted-foreground">Name</Label>
                <p className="text-sm font-medium mt-0.5">{user.name}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Email</Label>
                <p className="text-sm font-medium mt-0.5">{user.email}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Company</Label>
                <p className="text-sm font-medium mt-0.5">{user.company.name}</p>
              </div>
            </div>
          )}
          <Button
            onClick={async () => {
              await logout();
              await useTrackerStore.getState().reset();
            }}
            variant="outline"
            className="gap-2 w-full h-9 mt-2"
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </Button>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Synchronization
            </CardTitle>
            <Button
              onClick={() => loadQueueStats(true)}
              disabled={isLoadingStats}
              size="sm"
              variant="ghost"
              className="h-7 px-2"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingStats ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0 px-4 pb-4">
          {queueStats ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">In queue:</span>
                <span className="font-medium">{queueStats.pending_count}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Errors:</span>
                <span className="font-medium text-foreground">{queueStats.failed_count}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Synced:</span>
                <span className="font-medium text-foreground">{queueStats.sent_count}</span>
              </div>
              {Object.keys(queueStats.pending_by_type).length > 0 && (
                <div className="pt-2 border-t border-border">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">By task type:</Label>
                  <div className="space-y-1">
                    {Object.entries(queueStats.pending_by_type).map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground/80">{type}:</span>
                        <span className="font-medium">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {queueStats.pending_count > 0 && queueStats.sent_count === 0 && (
                <div className="pt-2 border-t border-border space-y-1">
                  <p className="text-xs font-medium text-foreground">
                    To synchronize, you need to log in to your account.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    If logs show «access_token present=false» — log out and log in again (Tracker tab → logout, then login). After login the counter will start increasing.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {isLoadingStats ? 'Loading...' : 'No data'}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

