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
        <Card className="border-2">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              У вас нет доступа к настройкам. Доступ разрешен только для владельцев и администраторов.
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
      // Токен: сначала из API (in-memory), потом из localStorage — иначе Rust sync не видит токен
      const accessToken = api.getAccessToken() || localStorage.getItem('access_token');
      const refreshToken = localStorage.getItem('refresh_token');
      if (accessToken) {
        const user = useAuthStore.getState().user;
        await invoke('set_auth_tokens', {
          accessToken,
          refreshToken,
          userId: user ? String(user.id) : null,
        });
      } else {
        logger.warn('SETTINGS', 'No access_token in api or localStorage — sync will skip until you log in again');
      }
      if (runSync) {
        try {
          const synced = await invoke<number>('sync_queue_now');
          if (synced > 0) {
            logger.info('SETTINGS', `Synced ${synced} task(s)`);
          }
        } catch (e) {
          logger.warn('SETTINGS', 'sync_queue_now failed', e);
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

  const handleSave = async () => {
    if (!isMountedRef.current) return;
    
    setIsSaving(true);
    setSaved(false);
    
    try {
      // Validate threshold (must be at least 1 minute)
      const validThreshold = Math.max(1, Math.floor(threshold));
      setThreshold(validThreshold);
      setIdleThreshold(validThreshold);
      
      // Log for debugging
      await logger.safeLogToRust(`[SETTINGS] Idle threshold saved: ${validThreshold} minutes`).catch((e) => {
        logger.debug('SETTINGS', 'Failed to log (non-critical)', e);
      });
      
      // Show notification
      await invoke('show_notification', {
        title: 'Settings saved',
        body: `Порог неактивности установлен: ${validThreshold} ${validThreshold === 1 ? 'минута' : validThreshold < 5 ? 'минуты' : 'минут'}`,
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
        title: 'Ошибка',
        body: 'Не удалось сохранить настройки',
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
    <div className="space-y-3">
      <Card className="border-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="space-y-2">
            <Label htmlFor="idle-threshold" className="text-sm">
              Порог неактивности (мин)
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
                disabled={isSaving || threshold === idleThreshold}
              >
                {isSaving ? (
                  'Сохранение...'
                ) : saved ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Saved
                  </>
                ) : (
                  'Сохранить'
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Автопауза при неактивности более {idleThreshold} {idleThreshold === 1 ? 'минуты' : idleThreshold < 5 ? 'минут' : 'минут'}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
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
            variant="destructive"
            className="gap-2 w-full h-9 mt-2"
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </Button>
        </CardContent>
      </Card>

      <Card className="border-2">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4" />
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
        <CardContent className="space-y-3 pt-0">
          {queueStats ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">In queue:</span>
                <span className="font-medium">{queueStats.pending_count}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Errors:</span>
                <span className={`font-medium ${queueStats.failed_count > 0 ? 'text-destructive' : ''}`}>
                  {queueStats.failed_count}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Синхронизировано:</span>
                <span className="font-medium text-green-600 dark:text-green-500">{queueStats.sent_count}</span>
              </div>
              {Object.keys(queueStats.pending_by_type).length > 0 && (
                <div className="pt-2 border-t">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">По типам задач:</Label>
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
                <div className="pt-2 border-t space-y-1">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    To synchronize, you need to log in to your account.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Если в логах «access_token present=false» — выйдите из аккаунта и войдите снова (вкладка «Трекер» → выход, затем логин). После входа счётчик начнёт расти.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {isLoadingStats ? 'Загрузка...' : 'Нет данных'}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

