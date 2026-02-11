import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { logger } from '../lib/logger';

interface FailedTask {
  id: number;
  entity_type: string;
  payload: string;
  retry_count: number;
  created_at: number;
  last_retry_at: number | null;
  error_message: string | null;
}

interface FailedTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failedCount: number;
  onRetry: () => void;
}

export function FailedTasksDialog({
  open,
  onOpenChange,
  failedCount,
  onRetry,
}: FailedTasksDialogProps) {
  const [tasks, setTasks] = useState<FailedTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // BUG FIX: Track component mount state to prevent setState after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // BUG FIX: Use useCallback to ensure stable function reference for useEffect dependencies
  const loadFailedTasks = useCallback(async () => {
    // BUG FIX: Check if component is still mounted before updating state
    if (!isMountedRef.current) return;
    
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<FailedTask[]>('get_failed_tasks', {
        limit: 50,
      });
      
      // BUG FIX: Check again after async operation
      if (!isMountedRef.current) return;
      
      setTasks(result);
    } catch (err: any) {
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMountedRef.current) return;
      
      setError(err.message || 'Could not load failed tasks');
      logger.error('FAILED_TASKS', 'Failed to load failed tasks', err);
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const handleRetry = async () => {
    // BUG FIX: Check if component is still mounted before updating state
    if (!isMountedRef.current) return;
    
    setIsRetrying(true);
    setError(null);
    try {
      const count = await invoke<number>('retry_failed_tasks', {
        limit: 100,
      });
      
      // BUG FIX: Check if component is still mounted before continuing
      if (!isMountedRef.current) return;
      
      await loadFailedTasks(); // Обновляем список
      onRetry(); // Обновляем индикатор синхронизации
      // Показываем уведомление
      await invoke('show_notification', {
        title: 'Retry synchronization',
        body: `Reset ${count} tasks for retry`,
      }).catch((e) => {
        // BUG FIX: Log error instead of silently ignoring
        logger.debug('FAILED_TASKS', 'Failed to show notification (non-critical)', e);
      });
    } catch (err: any) {
      // BUG FIX: Check if component is still mounted before updating state
      if (!isMountedRef.current) return;
      
      setError(err.message || 'Could not retry sync');
      logger.error('FAILED_TASKS', 'Failed to retry failed tasks', err);
    } finally {
      // BUG FIX: Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsRetrying(false);
      }
    }
  };

  useEffect(() => {
    if (open) {
      loadFailedTasks();
    }
  }, [open, loadFailedTasks]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString('ru-RU');
  };

  const getEntityTypeLabel = (entityType: string) => {
    const labels: Record<string, string> = {
      time_entry_start: 'Start tracking',
      time_entry_pause: 'Pause',
      time_entry_resume: 'Resume',
      time_entry_stop: 'Stop',
      screenshot: 'Screenshot',
      activity: 'Activity',
    };
    return labels[entityType] || entityType;
  };

  const getPayloadPreview = (payload: string) => {
    try {
      const parsed = JSON.parse(payload);
      // Удаляем токены и зашифрованные данные для безопасности
      const safe: any = { ...parsed };
      delete safe.accessToken;
      delete safe.refreshToken;
      delete safe._encrypted;
      delete safe.imageData; // Скриншоты могут быть большими
      return JSON.stringify(safe, null, 2);
    } catch {
      return payload.substring(0, 100) + '...';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" />
            Sync errors ({failedCount})
          </DialogTitle>
          <DialogDescription>
            Tasks that could not be synced after several attempts
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading...
              </span>
            </div>
          ) : error ? (
            <div className="text-sm text-destructive py-4 text-center">
              {error}
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              No failed tasks
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="p-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-red-900 dark:text-red-100">
                          {getEntityTypeLabel(task.entity_type)}
                        </span>
                        <span className="text-xs text-red-600 dark:text-red-400">
                          (ID: {task.id})
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Attempts: {task.retry_count} / 5
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created: {formatDate(task.created_at)}
                      </div>
                      {task.last_retry_at && (
                        <div className="text-xs text-muted-foreground">
                          Last attempt:{' '}
                          {formatDate(task.last_retry_at)}
                        </div>
                      )}
                      {task.error_message ? (
                        <div className="mt-2 p-2 rounded bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700">
                          <div className="text-xs font-medium text-red-800 dark:text-red-200 mb-1">
                            Error reason:
                          </div>
                          <div className="text-xs text-red-700 dark:text-red-300 font-mono break-words">
                            {task.error_message}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 p-2 rounded bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700">
                          <div className="text-xs text-yellow-800 dark:text-yellow-200">
                            ⚠️ Error reason not saved (old task)
                          </div>
                        </div>
                      )}
                      <details className="mt-2">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          Show payload
                        </summary>
                        <pre className="mt-1 p-2 text-xs bg-muted rounded overflow-auto max-h-32 font-mono">
                          {getPayloadPreview(task.payload)}
                        </pre>
                      </details>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-4 border-t">
          <div className="text-xs text-muted-foreground">
            Showing {tasks.length} of {failedCount} tasks
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={loadFailedTasks}
              disabled={isLoading}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Refresh
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleRetry}
              disabled={isRetrying || failedCount === 0}
            >
              {isRetrying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Retry all ({failedCount})
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
