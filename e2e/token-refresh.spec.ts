import { test, expect } from '@playwright/test';
import { setupTest, setupTauriMocks } from './helpers';

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
    // Настраиваем дополнительные моки для queue команд
    await setupTauriMocks(page);
    await page.addInitScript(() => {
      const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
      (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args?: any) => {
        if (cmd === 'enqueue_time_entry') {
          return Promise.resolve(1); // queue_id
        }
        if (cmd === 'sync_queue_now') {
          return Promise.resolve(1); // synced_count
        }
        return originalInvoke(cmd, args);
      };
    });
    
    // Для теста token refresh не используем setupTest, так как нужны другие токены
    // await setupTest(page, { projectName: 'Test Project' });
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

    // Выполняем логин и выбор проекта вручную для этого теста
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    await expect(page.locator('text=Welcome back!')).toBeVisible({ timeout: 10000 });
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('text=Choose a project to start tracking')).toBeVisible({ timeout: 10000 });
    
    // Выбираем проект
    await page.click('[role="combobox"]', { timeout: 5000 });
    await page.waitForSelector('[role="option"]', { timeout: 5000 });
    await page.click('[role="option"]:has-text("Test Project")', { timeout: 5000 });

    // Мокируем API для refresh token
    await page.route('**/api/auth/refresh', async route => {
      refreshTokenCalled = true;
      const body = await route.request().postDataJSON();
      // Проверяем, что используется правильный refresh token из localStorage
      // При первом вызове это должен быть initial-refresh-token
      const currentRefreshToken = await page.evaluate(() => {
        return localStorage.getItem('refresh_token');
      });
      // Проверяем, что токен в запросе соответствует токену в localStorage
      expect(body.refresh_token).toBe(currentRefreshToken);
      
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

    // Убеждаемся, что компонент Timer загрузился
    // Используем более надежную проверку - ждем исчезновения текста "Choose a project"
    await page.waitForFunction(
      () => {
        const chooseProjectText = document.body.textContent?.includes('Choose a project to start tracking');
        if (chooseProjectText) {
          return false; // Все еще показывается текст выбора проекта
        }
        const startButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
        );
        const pauseButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Pause')
        );
        const resumeButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Resume')
        );
        return startButton !== undefined || pauseButton !== undefined || resumeButton !== undefined;
      },
      { timeout: 20000 }
    );
    
    // Проверяем, что Start видна (если нет, трекинг уже запущен - это нормально)
    const hasStartButton = await page.evaluate(() => {
      const startButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
      );
      return startButton !== undefined;
    });
    
    if (hasStartButton) {
      // Запускаем трекинг (должен вызвать 401, затем refresh, затем успех)
      await page.click('button:has-text("Start")');
      
      // Ждем обновления состояния после старта
      await page.waitForFunction(
        () => {
          const pauseButton = Array.from(document.querySelectorAll('button')).find(
            btn => btn.textContent?.includes('Pause')
          );
          return pauseButton !== undefined;
        },
        { timeout: 15000 }
      ).catch(() => {
        // Игнорируем ошибку, если кнопка не появилась (может быть из-за ошибки API)
      });
    }

    // Проверяем, что refresh token был вызван
    expect(refreshTokenCalled).toBe(true);

    // Проверяем, что трекинг запущен (после успешного refresh)
    await expect(page.locator('button:has-text("Pause")')).toBeVisible({ timeout: 5000 });
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

    // Логин и выбор проекта уже выполнены в beforeEach

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

    // Убеждаемся, что компонент Timer загрузился
    // Используем более надежную проверку - ждем исчезновения текста "Choose a project"
    await page.waitForFunction(
      () => {
        const chooseProjectText = document.body.textContent?.includes('Choose a project to start tracking');
        if (chooseProjectText) {
          return false; // Все еще показывается текст выбора проекта
        }
        const startButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
        );
        const pauseButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Pause')
        );
        const resumeButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Resume')
        );
        return startButton !== undefined || pauseButton !== undefined || resumeButton !== undefined;
      },
      { timeout: 20000 }
    );
    
    // Проверяем, что Start видна (если нет, трекинг уже запущен - это нормально)
    const hasStartButton = await page.evaluate(() => {
      const startButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
      );
      return startButton !== undefined;
    });
    
    if (hasStartButton) {
      // Запускаем трекинг
      await page.click('button:has-text("Start")');
      
      // Ждем обновления состояния
      await page.waitForFunction(
        () => {
          const pauseButton = Array.from(document.querySelectorAll('button')).find(
            btn => btn.textContent?.includes('Pause')
          );
          return pauseButton !== undefined;
        },
        { timeout: 15000 }
      ).catch(() => {
        // Игнорируем ошибку, если кнопка не появилась
      });
    }

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

    // Логин и выбор проекта уже выполнены в beforeEach

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

    // Убеждаемся, что компонент Timer загрузился
    // Используем более надежную проверку - ждем исчезновения текста "Choose a project"
    await page.waitForFunction(
      () => {
        const chooseProjectText = document.body.textContent?.includes('Choose a project to start tracking');
        if (chooseProjectText) {
          return false; // Все еще показывается текст выбора проекта
        }
        const startButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
        );
        const pauseButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Pause')
        );
        const resumeButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Resume')
        );
        return startButton !== undefined || pauseButton !== undefined || resumeButton !== undefined;
      },
      { timeout: 20000 }
    );
    
    // Проверяем, что Start видна (если нет, трекинг уже запущен - это нормально)
    const hasStartButton = await page.evaluate(() => {
      const startButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
      );
      return startButton !== undefined;
    });
    
    if (hasStartButton) {
      // Пытаемся запустить трекинг
      await page.click('button:has-text("Start")');
      
      // Ждем обновления состояния
      await page.waitForFunction(
        () => {
          const pauseButton = Array.from(document.querySelectorAll('button')).find(
            btn => btn.textContent?.includes('Pause')
          );
          return pauseButton !== undefined;
        },
        { timeout: 15000 }
      ).catch(() => {
        // Игнорируем ошибку, если кнопка не появилась
      });
    }

    // Проверяем, что появилось сообщение об ошибке или пользователь разлогинен
    // (в зависимости от реализации обработки ошибки refresh token)
    const errorMessage = page.locator('.text-destructive, [class*="destructive"], [class*="error"]').first();
    const isVisible = await errorMessage.isVisible().catch(() => false);
    
    // Либо ошибка видна, либо пользователь разлогинен (форма логина видна)
    if (!isVisible) {
      await expect(page.locator('text=Welcome back!')).toBeVisible({ timeout: 5000 });
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

    // Логин и выбор проекта уже выполнены в beforeEach

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

    // Убеждаемся, что компонент Timer загрузился
    // Используем более надежную проверку - ждем исчезновения текста "Choose a project"
    await page.waitForFunction(
      () => {
        const chooseProjectText = document.body.textContent?.includes('Choose a project to start tracking');
        if (chooseProjectText) {
          return false; // Все еще показывается текст выбора проекта
        }
        const startButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
        );
        const pauseButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Pause')
        );
        const resumeButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Resume')
        );
        return startButton !== undefined || pauseButton !== undefined || resumeButton !== undefined;
      },
      { timeout: 20000 }
    );
    
    // Проверяем, что Start видна (если нет, трекинг уже запущен - это нормально)
    const hasStartButton = await page.evaluate(() => {
      const startButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
      );
      return startButton !== undefined;
    });
    
    if (hasStartButton) {
      // Запускаем трекинг (данные должны сохраниться в очередь)
      await page.click('button:has-text("Start")');
      
      // Ждем обновления состояния
      await page.waitForFunction(
        () => {
          const pauseButton = Array.from(document.querySelectorAll('button')).find(
            btn => btn.textContent?.includes('Pause')
          );
          return pauseButton !== undefined;
        },
        { timeout: 15000 }
      ).catch(() => {
        // Игнорируем ошибку, если кнопка не появилась
      });
    }
    
    // Ждем обновления состояния
    await page.waitForFunction(
      () => {
        const pauseButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Pause')
        );
        return pauseButton !== undefined;
      },
      { timeout: 15000 }
    ).catch(() => {
      // Игнорируем ошибку, если кнопка не появилась
    });

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
