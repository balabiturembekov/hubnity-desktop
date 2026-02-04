import { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../lib/logger';
import { captureException, setSentryContext } from '../lib/sentry';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * PRODUCTION: Error Boundary для обработки ошибок React компонентов
 * 
 * Правила:
 * - Логирует ошибки с полным контекстом
 * - Показывает user-friendly fallback UI
 * - Позволяет перезапустить UI
 * - НЕ использует alert() или blank screen
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Обновляем состояние для отображения fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Логируем ошибку с полным контекстом
    logger.error('ERROR_BOUNDARY', 'React component error caught', {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      componentStack: errorInfo.componentStack,
    });

    // Отправляем ошибку в Sentry с контекстом
    setSentryContext('react_error_boundary', {
      componentStack: errorInfo.componentStack,
      errorName: error.name,
      errorMessage: error.message,
    });
    
    captureException(error, {
      react: {
        componentStack: errorInfo.componentStack,
      },
    });

    // Сохраняем errorInfo для отображения в dev режиме
    this.setState({
      errorInfo,
    });
  }

  handleReset = () => {
    // Сбрасываем состояние и перезапускаем UI
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      // Если есть кастомный fallback, используем его
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-500" />
                <CardTitle>Произошла ошибка</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600">
                Приложение столкнулось с неожиданной ошибкой. Мы зафиксировали проблему и работаем над её решением.
              </p>
              
              {import.meta.env.DEV && this.state.error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-xs font-mono overflow-auto max-h-40">
                  <div className="text-red-800 font-semibold mb-1">
                    {this.state.error.name}: {this.state.error.message}
                  </div>
                  {this.state.error.stack && (
                    <pre className="text-red-600 whitespace-pre-wrap break-words">
                      {this.state.error.stack}
                    </pre>
                  )}
                  {this.state.errorInfo?.componentStack && (
                    <details className="mt-2">
                      <summary className="text-red-700 cursor-pointer">Component Stack</summary>
                      <pre className="text-red-600 whitespace-pre-wrap break-words mt-1">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={this.handleReset}
                  className="flex-1"
                  variant="default"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Перезапустить
                </Button>
                <Button
                  onClick={() => window.location.reload()}
                  variant="outline"
                  className="flex-1"
                >
                  Обновить страницу
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
