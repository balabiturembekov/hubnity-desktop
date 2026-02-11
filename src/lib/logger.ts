/**
 * PRODUCTION: Централизованное структурированное логирование
 * 
 * Уровни:
 * - debug: только в dev режиме
 * - info: информационные сообщения
 * - warn: предупреждения
 * - error: ошибки
 * 
 * Правила:
 * - НЕ логировать токены
 * - НЕ логировать полные payload
 * - Всегда добавлять контекст
 * - Интегрировано с Sentry для мониторинга ошибок
 */

import { invoke } from '@tauri-apps/api/core';
import { captureException } from './sentry';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const isDev = import.meta.env.DEV;

class Logger {
  private shouldLog(level: LogLevel): boolean {
    // В production не логируем debug
    if (level === 'debug' && !isDev) {
      return false;
    }
    return true;
  }

  private formatMessage(context: string, message: string, error?: unknown): string {
    const timestamp = new Date().toISOString();
    const errorInfo = error instanceof Error 
      ? ` | Error: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
      : error 
      ? ` | Error: ${String(error)}`
      : '';
    
    return `[${timestamp}] [${context}] ${message}${errorInfo}`;
  }

  debug(context: string, message: string, data?: unknown) {
    if (!this.shouldLog('debug')) return;
    console.debug(this.formatMessage(context, message), data || '');
  }

  info(context: string, message: string, data?: unknown) {
    if (!this.shouldLog('info')) return;
    console.info(this.formatMessage(context, message), data || '');
  }

  warn(context: string, message: string, data?: unknown) {
    if (!this.shouldLog('warn')) return;
    console.warn(this.formatMessage(context, message), data || '');
  }

  error(context: string, message: string, error?: unknown) {
    if (!this.shouldLog('error')) return;
    console.error(this.formatMessage(context, message, error));
    
    // Отправляем ошибки в Sentry для мониторинга
    if (error instanceof Error) {
      captureException(error, {
        logger: {
          context,
          message,
        },
      });
    } else if (error) {
      // Если это не Error объект, создаем новый Error для Sentry
      const errorObj = new Error(message);
      captureException(errorObj, {
        logger: {
          context,
          originalError: String(error),
        },
      });
    }
  }

  /**
   * Логирование ошибок из catch блоков
   * Сохраняет stack trace и контекст
   * Отправляет в Sentry для мониторинга
   */
  logError(context: string, error: unknown, additionalInfo?: string) {
    const message = additionalInfo || 'Unhandled error';
    this.error(context, message, error);
    
    // Дополнительно отправляем в Sentry с контекстом
    if (error instanceof Error) {
      captureException(error, {
        logger: {
          context,
          additionalInfo,
        },
      });
    }
  }

  /**
   * Безопасное логирование через Tauri invoke('log_message')
   * Не критично, если не удалось - просто логируем локально
   */
  async safeLogToRust(message: string): Promise<void> {
    try {
      await invoke('log_message', { message });
    } catch (e) {
      // Не критично - просто логируем локально
      this.debug('Logger', `Failed to log to Rust: ${message}`, e);
    }
  }
}

export const logger = new Logger();
