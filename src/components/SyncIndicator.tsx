import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, WifiOff, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { FailedTasksDialog } from './FailedTasksDialog';
import { useSyncStore } from '../store/useSyncStore';

function formatLastSync(ts: number): string {
  const now = Date.now() / 1000;
  const diff = Math.floor(now - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d ago`;
  return `${Math.floor(diff / 604800)} wk ago`;
}

type SyncState = 'synced' | 'syncing' | 'offline' | 'error';

export function SyncIndicator() {
  const { status, isLoading, fetchSyncStatus } = useSyncStore();
  const [showFailedDialog, setShowFailedDialog] = useState(false);

  useEffect(() => {
    fetchSyncStatus();
    const interval = setInterval(fetchSyncStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  if (isLoading || !status) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Checking...</span>
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

  const stateConfig: Record<
    SyncState,
    { icon: typeof CheckCircle2; animate?: boolean }
  > = {
    synced: { icon: CheckCircle2 },
    syncing: { icon: Loader2, animate: true },
    offline: { icon: WifiOff },
    error: { icon: AlertCircle },
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
            ? status.last_sync_at != null
              ? `All data synced. Last sync: ${formatLastSync(status.last_sync_at)}`
              : 'All data synced'
            : syncState === 'syncing'
            ? `${status.pending_count} tasks in queue`
            : syncState === 'offline'
            ? 'Last update failed. Data will sync when connection is restored.'
            : `Click to view details of ${status.failed_count} errors`
        }
        onClick={() => {
          if (syncState === 'error') {
            setShowFailedDialog(true);
          }
        }}
      >
        {syncState === 'error' ? (
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
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
                ? status.last_sync_at != null
                  ? `Last sync ${formatLastSync(status.last_sync_at)}`
                  : 'Synced'
                : syncState === 'syncing'
                ? `${status.pending_count}`
                : 'Last update failed'
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
