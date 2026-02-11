import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Loader2, WifiOff, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { FailedTasksDialog } from './FailedTasksDialog';
import { logger } from '../lib/logger';

interface SyncStatus {
  pending_count: number;
  failed_count: number;
  is_online: boolean;
}

type SyncState = 'synced' | 'syncing' | 'offline' | 'error';

export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showFailedDialog, setShowFailedDialog] = useState(false);
  
  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // BUG FIX: Use useCallback to ensure stable function reference for useEffect dependencies
  const fetchSyncStatus = useCallback(async () => {
    // BUG FIX: Check if component is still mounted before updating state
    if (!isMountedRef.current) return;
    
    try {
      const result = await invoke<SyncStatus>('get_sync_status');
      
      // BUG FIX: Check again after async operation
      if (!isMountedRef.current) return;
      
      setStatus(result);
      setIsLoading(false);
    } catch (error) {
      logger.error('SYNC_INDICATOR', 'Failed to get sync status', error);
      
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMountedRef.current) return;
      
      setIsLoading(false);
      // При ошибке считаем, что офлайн
      setStatus({
        pending_count: 0,
        failed_count: 0,
        is_online: false,
      });
    }
  }, []);

  useEffect(() => {
    // Загружаем статус сразу
    fetchSyncStatus();

    // Обновляем каждые 5 секунд
    const interval = setInterval(fetchSyncStatus, 5000);

    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  if (isLoading || !status) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Проверка...</span>
      </div>
    );
  }

  // Определяем состояние синхронизации
  const getSyncState = (): SyncState => {
    if (!status.is_online) {
      return 'offline';
    }
    if (status.failed_count > 0) {
      return 'error';
    }
    if (status.pending_count > 0) {
      return 'syncing';
    }
    return 'synced';
  };

  const syncState = getSyncState();

  // Конфигурация для каждого состояния
  const stateConfig: Record<
    SyncState,
    {
      icon: typeof CheckCircle2;
      text: string;
      className: string;
      bgClassName: string;
      borderClassName: string;
      animate?: boolean;
    }
  > = {
    synced: {
      icon: CheckCircle2,
      text: 'Синхронизировано',
      className: 'text-green-600 dark:text-green-500',
      bgClassName: 'bg-green-50 dark:bg-green-950/20',
      borderClassName: 'border-green-200 dark:border-green-800',
    },
    syncing: {
      icon: Loader2,
      text: `Синхронизация... (${status.pending_count})`,
      className: 'text-blue-600 dark:text-blue-500',
      bgClassName: 'bg-blue-50 dark:bg-blue-950/20',
      borderClassName: 'border-blue-200 dark:border-blue-800',
      animate: true,
    },
    offline: {
      icon: WifiOff,
      text: 'Офлайн',
      className: 'text-orange-600 dark:text-orange-500',
      bgClassName: 'bg-orange-50 dark:bg-orange-950/20',
      borderClassName: 'border-orange-200 dark:border-orange-800',
    },
    error: {
      icon: AlertCircle,
      text: `Ошибка (${status.failed_count})`,
      className: 'text-red-600 dark:text-red-500',
      bgClassName: 'bg-red-50 dark:bg-red-950/20',
      borderClassName: 'border-red-200 dark:border-red-800',
    },
  };

  const config = stateConfig[syncState];
  const Icon = config.icon;

  return (
    <>
      {/* macOS-style subtle sync indicator - минимальный визуальный вес */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-1.5 py-0.5 transition-colors',
          syncState === 'error' && 'cursor-pointer hover:opacity-70',
        )}
        title={
          syncState === 'synced'
            ? 'Все данные синхронизированы'
            : syncState === 'syncing'
            ? `${status.pending_count} задач в очереди`
            : syncState === 'offline'
            ? 'Нет подключения к интернету. Данные будут синхронизированы при восстановлении связи.'
            : `Кликните, чтобы посмотреть детали ${status.failed_count} ошибок`
        }
        onClick={() => {
          if (syncState === 'error') {
            setShowFailedDialog(true);
          }
        }}
      >
        {syncState === 'error' ? (
          // При ошибке - только subtle red dot, без текста
          <div className="w-1.5 h-1.5 rounded-full bg-red-500/70" />
        ) : (
          <>
            <Icon
              className={cn(
                'h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/50',
                config.animate && 'animate-spin'
              )}
            />
            <span className="text-xs text-muted-foreground/50">
              {syncState === 'synced' 
                ? 'Синхронизировано'
                : syncState === 'syncing'
                ? `${status.pending_count}`
                : 'Офлайн'
              }
            </span>
          </>
        )}
      </div>

      <FailedTasksDialog
        open={showFailedDialog}
        onOpenChange={setShowFailedDialog}
        failedCount={status.failed_count}
        onRetry={fetchSyncStatus}
      />
    </>
  );
}
