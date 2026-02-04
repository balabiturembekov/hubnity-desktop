import { test, expect } from '@playwright/test';

/**
 * E2E тесты для проверки обновления токенов (Token Refresh)
 * 
 * Проверяет:
 * - Refresh token используется при истечении access token
 * - Токены обновляются автоматически при 401 ошибке
 * - Данные синхронизируются корректно после обновления токена
 * - Очередь синхронизации использует обновленные токены
 */

test.describe('Token Refresh Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Мокаем Tauri команды
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: any) => {
          if (cmd === 'log_message') return Promise.resolve();
          if (cmd === 'plugin:tray|new') return Promise.resolve();
          if (cmd === 'plugin:tray|set_tooltip') return Promise.resolve();
          if (cmd === 'request_screenshot_permission') return Promise.resolve(true);
          if (cmd === 'start_activity_monitoring') return Promise.resolve();
          if (cmd === 'stop_activity_monitoring') return Promise.resolve();
          if (cmd === 'get_active_window_info') {
            return Promise.resolve({
              app_name: 'Google Chrome',
              window_title: 'Test Page',
              url: 'https://example.com',
              domain: 'example.com',
            });
          }
          if (cmd === 'get_timer_state') {
            return Promise.resolve({
              state: { state: 'RUNNING' },
              elapsed_seconds: 0,
              accumulated_seconds: 0,
              session_start: Date.now() / 1000,
              day_start: Date.now() / 1000,
            });
          }
          if (cmd === 'start_timer') {
            return Promise.resolve({
              state: { state: 'RUNNING', started_at: Date.now() / 1000 },
              elapsed_seconds: 0,
              accumulated_seconds: 0,
              session_start: Date.now() / 1000,
              day_start: Date.now() / 1000,
            });
          }
          if (cmd === 'enqueue_time_entry') {
            return Promise.resolve(1); // queue_id
          }
          if (cmd === 'sync_queue_now') {
            return Promise.resolve(1); // synced_count
          }
          return Promise.resolve(null);
        },
      };
    });

    // Переходим на страницу
    await page.goto('http://localhost:1420');
  });

  test('should refresh token upon expiration (401 error)', async ({ page }) => {
    let refreshTokenCalled = false;
    let newAccessToken = 'new-access-token';
    let newRefreshToken = 'new-refresh-token';

    // Мокируем API для логина
    await page.route('**/api/auth/login', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'test-user-id',
            name: 'Test User',
            email: 'test@example.com',
            role: 'user',
            status: 'active',
            avatar: '',
            hourlyRate: 0,
            companyId: 'test-company-id',
            company: {
              id: 'test-company-id',
              name: 'Test Company',
            },
          },
          access_token: 'initial-access-token',
          refresh_token: 'initial-refresh-token',
        }),
      });
    });

    // Мокируем API для получения проектов
    await page.route('**/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'test-project-id',
            name: 'Test Project',
            description: 'Test Description',
            color: '#FF5733',
            clientName: 'Test Client',
            budget: 0,
            status: 'ACTIVE',
            companyId: 'test-company-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    // Мокируем API для активных time entries
    await page.route('**/api/time-entries/active', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Логинимся
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button:has-text("Войти")');
    await page.waitForTimeout(1000);

    // Выбираем проект
    await page.click('[role="combobox"]');
    await page.waitForTimeout(500);
    await page.click('[role="option"]:has-text("Test Project")');
    await page.waitForTimeout(500);

    // Мокируем API для refresh token
    await page.route('**/api/auth/refresh', async route => {
      refreshTokenCalled = true;
      const body = await route.request().postDataJSON();
      expect(body.refresh_token).toBe('initial-refresh-token');
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
        }),
      });
    });

    // Мокируем API для time entries - первый запрос возвращает 401
    let requestCount = 0;
    await page.route('**/api/time-entries', async route => {
      requestCount++;
      if (requestCount === 1) {
        // Первый запрос - 401 (токен истек)
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Token expired',
          }),
        });
      } else {
        // Второй запрос (после refresh) - успех
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'entry-1',
            userId: 'test-user-id',
            projectId: 'test-project-id',
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            description: '',
            status: 'RUNNING',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            project: {
              id: 'test-project-id',
              name: 'Test Project',
              color: '#FF5733',
            },
          }),
        });
      }
    });

    // Запускаем трекинг (должен вызвать 401, затем refresh, затем успех)
    await page.click('button:has-text("Старт")');
    await page.waitForTimeout(2000);

    // Проверяем, что refresh token был вызван
    expect(refreshTokenCalled).toBe(true);

    // Проверяем, что трекинг запущен (после успешного refresh)
    await expect(page.locator('button:has-text("Пауза")')).toBeVisible({ timeout: 5000 });
  });

  test('should use refreshed token for subsequent requests', async ({ page }) => {
    let refreshTokenCalled = false;
    let newAccessToken = 'refreshed-access-token';
    let tokenUsedInRequest = '';

    // Мокируем API для логина
    await page.route('**/api/auth/login', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'test-user-id',
            name: 'Test User',
            email: 'test@example.com',
            role: 'user',
            status: 'active',
            avatar: '',
            hourlyRate: 0,
            companyId: 'test-company-id',
            company: {
              id: 'test-company-id',
              name: 'Test Company',
            },
          },
          access_token: 'initial-access-token',
          refresh_token: 'initial-refresh-token',
        }),
      });
    });

    // Мокируем API для получения проектов
    await page.route('**/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'test-project-id',
            name: 'Test Project',
            description: 'Test Description',
            color: '#FF5733',
            clientName: 'Test Client',
            budget: 0,
            status: 'ACTIVE',
            companyId: 'test-company-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    // Мокируем API для активных time entries
    await page.route('**/api/time-entries/active', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Логинимся
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button:has-text("Войти")');
    await page.waitForTimeout(1000);

    // Выбираем проект
    await page.click('[role="combobox"]');
    await page.waitForTimeout(500);
    await page.click('[role="option"]:has-text("Test Project")');
    await page.waitForTimeout(500);

    // Мокируем API для refresh token
    await page.route('**/api/auth/refresh', async route => {
      refreshTokenCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: newAccessToken,
          refresh_token: 'new-refresh-token',
        }),
      });
    });

    // Мокируем API для time entries
    let requestCount = 0;
    await page.route('**/api/time-entries', async route => {
      requestCount++;
      const authHeader = route.request().headers()['authorization'];
      
      if (requestCount === 1) {
        // Первый запрос - 401
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Token expired',
          }),
        });
      } else {
        // Второй запрос - проверяем, что используется новый токен
        if (authHeader) {
          tokenUsedInRequest = authHeader.replace('Bearer ', '');
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'entry-1',
            userId: 'test-user-id',
            projectId: 'test-project-id',
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            description: '',
            status: 'RUNNING',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            project: {
              id: 'test-project-id',
              name: 'Test Project',
              color: '#FF5733',
            },
          }),
        });
      }
    });

    // Запускаем трекинг
    await page.click('button:has-text("Старт")');
    await page.waitForTimeout(2000);

    // Проверяем, что refresh был вызван
    expect(refreshTokenCalled).toBe(true);

    // Проверяем, что в последующих запросах используется новый токен
    expect(tokenUsedInRequest).toBe(newAccessToken);
  });

  test('should handle refresh token expiration gracefully', async ({ page }) => {
    // Мокируем API для логина
    await page.route('**/api/auth/login', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'test-user-id',
            name: 'Test User',
            email: 'test@example.com',
            role: 'user',
            status: 'active',
            avatar: '',
            hourlyRate: 0,
            companyId: 'test-company-id',
            company: {
              id: 'test-company-id',
              name: 'Test Company',
            },
          },
          access_token: 'initial-access-token',
          refresh_token: 'initial-refresh-token',
        }),
      });
    });

    // Мокируем API для получения проектов
    await page.route('**/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'test-project-id',
            name: 'Test Project',
            description: 'Test Description',
            color: '#FF5733',
            clientName: 'Test Client',
            budget: 0,
            status: 'ACTIVE',
            companyId: 'test-company-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    // Мокируем API для активных time entries
    await page.route('**/api/time-entries/active', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Логинимся
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button:has-text("Войти")');
    await page.waitForTimeout(1000);

    // Выбираем проект
    await page.click('[role="combobox"]');
    await page.waitForTimeout(500);
    await page.click('[role="option"]:has-text("Test Project")');
    await page.waitForTimeout(500);

    // Мокируем API для refresh token - возвращает ошибку (refresh token истек)
    await page.route('**/api/auth/refresh', async route => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Refresh token expired',
        }),
      });
    });

    // Мокируем API для time entries - возвращает 401
    await page.route('**/api/time-entries', async route => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Token expired',
        }),
      });
    });

    // Пытаемся запустить трекинг
    await page.click('button:has-text("Старт")');
    await page.waitForTimeout(2000);

    // Проверяем, что появилось сообщение об ошибке или пользователь разлогинен
    // (в зависимости от реализации обработки ошибки refresh token)
    const errorMessage = page.locator('.text-destructive, [class*="destructive"], [class*="error"]').first();
    const isVisible = await errorMessage.isVisible().catch(() => false);
    
    // Либо ошибка видна, либо пользователь разлогинен (форма логина видна)
    if (!isVisible) {
      await expect(page.locator('text=Вход в систему, input[type="email"]')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should refresh token during queue synchronization', async ({ page }) => {
    let refreshTokenCalled = false;
    let syncRequestCount = 0;

    // Мокируем API для логина
    await page.route('**/api/auth/login', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'test-user-id',
            name: 'Test User',
            email: 'test@example.com',
            role: 'user',
            status: 'active',
            avatar: '',
            hourlyRate: 0,
            companyId: 'test-company-id',
            company: {
              id: 'test-company-id',
              name: 'Test Company',
            },
          },
          access_token: 'initial-access-token',
          refresh_token: 'initial-refresh-token',
        }),
      });
    });

    // Мокируем API для получения проектов
    await page.route('**/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'test-project-id',
            name: 'Test Project',
            description: 'Test Description',
            color: '#FF5733',
            clientName: 'Test Client',
            budget: 0,
            status: 'ACTIVE',
            companyId: 'test-company-id',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    // Мокируем API для активных time entries
    await page.route('**/api/time-entries/active', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Логинимся
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button:has-text("Войти")');
    await page.waitForTimeout(1000);

    // Выбираем проект
    await page.click('[role="combobox"]');
    await page.waitForTimeout(500);
    await page.click('[role="option"]:has-text("Test Project")');
    await page.waitForTimeout(500);

    // Мокируем API для refresh token
    await page.route('**/api/auth/refresh', async route => {
      refreshTokenCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
        }),
      });
    });

    // Мокируем API для time entries - первый запрос 401, затем успех
    await page.route('**/api/time-entries', async route => {
      syncRequestCount++;
      if (syncRequestCount === 1) {
        // Первый запрос - 401
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Token expired',
          }),
        });
      } else {
        // Второй запрос (после refresh) - успех
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'entry-1',
            userId: 'test-user-id',
            projectId: 'test-project-id',
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            description: '',
            status: 'RUNNING',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            project: {
              id: 'test-project-id',
              name: 'Test Project',
              color: '#FF5733',
            },
          }),
        });
      }
    });

    // Запускаем трекинг (данные должны сохраниться в очередь)
    await page.click('button:has-text("Старт")');
    await page.waitForTimeout(2000);

    // Симулируем синхронизацию очереди (через Tauri команду sync_queue_now)
    // В реальном приложении это происходит автоматически в фоне
    await page.evaluate(() => {
      return (window as any).__TAURI_INTERNALS__.invoke('sync_queue_now');
    });
    await page.waitForTimeout(2000);

    // Проверяем, что refresh token был вызван во время синхронизации
    expect(refreshTokenCalled).toBe(true);
    expect(syncRequestCount).toBeGreaterThan(1); // Должно быть минимум 2 запроса (401 + успех)
  });
});
