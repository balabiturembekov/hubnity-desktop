/**
 * PRODUCTION: Конфигурация Sentry для мониторинга ошибок
 * 
 * Правила:
 * - Инициализируется только в production
 * - Фильтрует чувствительные данные (токены)
 * - Настроены source maps для production
 * - Интегрирован с ErrorBoundary и logger
 */

import * as Sentry from '@sentry/react';

const isDev = import.meta.env.DEV;
const isProduction = import.meta.env.PROD;

/**
 * Инициализация Sentry
 * Вызывается один раз при старте приложения
 */
export function initSentry() {
  // В dev режиме не инициализируем Sentry (или используем dev DSN)
  if (isDev) {
    // Можно использовать dev DSN для тестирования
    // Для production используем переменную окружения
    return;
  }

  // DSN берется из переменной окружения
  // В production должен быть установлен VITE_SENTRY_DSN
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    console.warn('[Sentry] DSN not configured. Error monitoring disabled.');
    return;
  }

  Sentry.init({
    dsn,
    environment: isProduction ? 'production' : 'development',
    
    // Интеграции
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],

    // Performance monitoring
    tracesSampleRate: isProduction ? 0.1 : 1.0, // 10% в production, 100% в dev
    
    // Session replay
    replaysSessionSampleRate: isProduction ? 0.1 : 1.0,
    replaysOnErrorSampleRate: 1.0, // Всегда записываем при ошибках

    // Release tracking
    release: import.meta.env.VITE_APP_VERSION || undefined,

    // Фильтрация данных перед отправкой
    beforeSend(event, _hint) {
      // Фильтруем токены из URL и других мест
      if (event.request) {
        // Удаляем токены из URL
        if (event.request.url) {
          event.request.url = event.request.url.replace(
            /(access_token|refresh_token|token)=[^&]*/gi,
            '$1=***'
          );
        }
        
        // Фильтруем headers
        if (event.request?.headers) {
          const sensitiveHeaders = ['authorization', 'x-auth-token'];
          sensitiveHeaders.forEach(header => {
            if (event.request!.headers![header]) {
              event.request!.headers![header] = '***';
            }
          });
        }
      }

      // Фильтруем токены из breadcrumbs
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map(breadcrumb => {
          if (breadcrumb.data) {
            Object.keys(breadcrumb.data).forEach(key => {
              if (key.toLowerCase().includes('token') || 
                  key.toLowerCase().includes('password')) {
                breadcrumb.data![key] = '***';
              }
            });
          }
          return breadcrumb;
        });
      }

      // Фильтруем токены из extra data
      if (event.extra) {
        Object.keys(event.extra).forEach(key => {
          if (key.toLowerCase().includes('token') || 
              key.toLowerCase().includes('password')) {
            event.extra![key] = '***';
          }
        });
      }

      return event;
    },

    // Игнорируем определенные ошибки
    ignoreErrors: [
      // Игнорируем ошибки из расширений браузера
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      // Игнорируем ошибки из Tauri (если они не критичны)
      'Tauri command failed',
    ],

    // Deny URLs для фильтрации
    denyUrls: [
      // Игнорируем ошибки из расширений браузера
      /extensions\//i,
      /^chrome:\/\//i,
      /^chrome-extension:\/\//i,
    ],
  });
}

/**
 * Установка пользовательского контекста
 */
export function setSentryUser(user: { id: string; email?: string }) {
  Sentry.setUser({
    id: user.id,
    email: user.email,
  });
}

/**
 * Очистка пользовательского контекста (при logout)
 */
export function clearSentryUser() {
  Sentry.setUser(null);
}

/**
 * Добавление дополнительного контекста к ошибкам
 */
export function setSentryContext(key: string, context: Record<string, unknown>) {
  Sentry.setContext(key, context);
}

/**
 * Отправка кастомного события
 */
export function captureException(error: Error, context?: Record<string, unknown>) {
  if (context) {
    Sentry.withScope((scope) => {
      Object.keys(context).forEach(key => {
        scope.setContext(key, context[key] as Record<string, unknown>);
      });
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

/**
 * Отправка сообщения (не ошибки)
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info') {
  Sentry.captureMessage(message, level);
}
