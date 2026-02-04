import { useEffect, useState, useCallback } from 'react';
import { api, Screenshot } from '../lib/api';
import { Loader2, Eye, ChevronDown, ChevronUp, Camera } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { logger } from '../lib/logger';

interface ScreenshotsViewProps {
  timeEntryId: string | null;
}

/**
 * PRODUCTION: Компактный ScreenshotsView
 * - Свернут по умолчанию
 * - Показывается только если есть скриншоты
 * - Компактный формат без Card обертки
 */
export function ScreenshotsView({ timeEntryId }: ScreenshotsViewProps) {
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedScreenshot, setSelectedScreenshot] = useState<Screenshot | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadScreenshots = useCallback(async () => {
    if (!timeEntryId) {
      setScreenshots([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getScreenshots(timeEntryId);
      setScreenshots(data);
      // Автоматически разворачиваем, если есть скриншоты
      if (data.length > 0) {
        setIsExpanded(true);
      }
    } catch (err: any) {
      setError(err.message || 'Не удалось загрузить скриншоты');
      setScreenshots([]);
    } finally {
      setIsLoading(false);
    }
  }, [timeEntryId]);

  const refreshScreenshots = useCallback(async () => {
    if (!timeEntryId) return;
    setIsRefreshing(true);
    try {
      const data = await api.getScreenshots(timeEntryId);
      setScreenshots(data);
    } catch (err: any) {
      logger.error('SCREENSHOTS_VIEW', 'Failed to refresh screenshots', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [timeEntryId]);

  useEffect(() => {
    if (!timeEntryId) return;
    
    const handleScreenshotUploaded = () => {
      setTimeout(() => {
        refreshScreenshots();
      }, 1000);
    };

    window.addEventListener('screenshot:uploaded', handleScreenshotUploaded);
    return () => {
      window.removeEventListener('screenshot:uploaded', handleScreenshotUploaded);
    };
  }, [timeEntryId, refreshScreenshots]);

  useEffect(() => {
    loadScreenshots();
  }, [timeEntryId, loadScreenshots]);

  useEffect(() => {
    if (!timeEntryId) return;
    
    const interval = setInterval(() => {
      refreshScreenshots();
    }, 30000);

    return () => clearInterval(interval);
  }, [timeEntryId, refreshScreenshots]);

  const getFullImageUrl = (imageUrl: string) => {
    if (imageUrl.startsWith('/')) {
      return `https://app.automatonsoft.de${imageUrl}`;
    }
    return imageUrl;
  };

  if (!timeEntryId) {
    return null; // Не показываем, если нет timeEntryId
  }

  // macOS-style secondary section - без рамки, минимальный визуальный вес
  return (
    <>
      <div className="w-full max-w-2xl mx-auto">
        {/* Компактный заголовок - без рамки, только иконка + текст */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between px-1 py-1.5 hover:bg-transparent transition-colors group"
        >
          <div className="flex items-center gap-2">
            <Camera className="h-3.5 w-3.5 text-muted-foreground/60" />
            <span className="text-xs text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
              Скриншоты
            </span>
            {screenshots.length > 0 && (
              <span className="text-xs text-muted-foreground/50">
                {screenshots.length}
              </span>
            )}
            {/* P1.3: Subtle hint для снижения тревожности */}
            <span className="text-xs text-muted-foreground/40 italic ml-0.5">
              (автоматически)
            </span>
            {(isLoading || isRefreshing) && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground/50" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
          )}
        </button>

        {/* Контент скриншотов - lazy render только при expanded */}
        {isExpanded && (
          <div className="mt-2 px-1 pb-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-xs text-muted-foreground">Загрузка...</span>
              </div>
            ) : error ? (
              <div className="text-xs text-destructive py-4 text-center">
                {error}
                <Button
                  variant="link"
                  size="sm"
                  onClick={loadScreenshots}
                  className="ml-2 h-auto p-0 text-xs"
                >
                  Повторить
                </Button>
              </div>
            ) : screenshots.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                Скриншоты появятся здесь после первого снимка
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {screenshots.map((screenshot) => (
                  <div
                    key={screenshot.id}
                    className="relative aspect-video bg-muted rounded-md overflow-hidden cursor-pointer hover:opacity-80 transition-opacity group"
                    onClick={() => setSelectedScreenshot(screenshot)}
                  >
                    <img
                      src={getFullImageUrl(screenshot.thumbnailUrl || screenshot.imageUrl)}
                      alt={`Screenshot ${new Date(screenshot.timestamp).toLocaleTimeString()}`}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23ddd"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3EНет изображения%3C/text%3E%3C/svg%3E';
                      }}
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                      <Eye className="h-3 w-3 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] px-1 py-0.5 truncate">
                      {new Date(screenshot.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialog для просмотра скриншота */}
      <Dialog open={!!selectedScreenshot} onOpenChange={(open) => !open && setSelectedScreenshot(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Скриншот</DialogTitle>
            <DialogDescription>
              {selectedScreenshot && new Date(selectedScreenshot.timestamp).toLocaleString()}
            </DialogDescription>
          </DialogHeader>
          {selectedScreenshot && (
            <div className="mt-4">
              <img
                src={getFullImageUrl(selectedScreenshot.imageUrl)}
                alt={`Screenshot ${new Date(selectedScreenshot.timestamp).toLocaleString()}`}
                className="w-full h-auto rounded-md"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="800" height="600"%3E%3Crect width="800" height="600" fill="%23ddd"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3EНе удалось загрузить изображение%3C/text%3E%3C/svg%3E';
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
