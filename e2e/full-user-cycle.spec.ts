import { test, expect } from '@playwright/test';

/**
 * E2E тесты для полного цикла пользователя
 * 
 * Тестирует:
 * 1. Логин
 * 2. Выбор проекта
 * 3. Старт трекинга
 * 4. Пауза
 * 5. Возобновление
 * 6. Стоп
 * 7. Проверка отображения времени
 */

test.describe('Полный цикл пользователя', () => {
  test.beforeEach(async ({ page }) => {
    // Мокируем Tauri команды
    await page.addInitScript(() => {
      // Мок для invoke
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: any) => {
          console.log(`[MOCK] invoke: ${cmd}`, args);
          
          // Моки для различных команд
          if (cmd === 'log_message') {
            return Promise.resolve();
          }
          
          if (cmd === 'plugin:tray|new') {
            return Promise.resolve();
          }
          
          if (cmd === 'plugin:tray|set_tooltip') {
            return Promise.resolve();
          }
          
          if (cmd === 'request_screenshot_permission') {
            return Promise.resolve(true);
          }
          
          if (cmd === 'start_activity_monitoring') {
            return Promise.resolve();
          }
          
          if (cmd === 'stop_activity_monitoring') {
            return Promise.resolve();
          }
          
          if (cmd === 'get_active_window_info') {
            return Promise.resolve({
              app_name: 'Google Chrome',
              window_title: 'Test Page',
              url: 'https://example.com',
              domain: 'example.com',
            });
          }
          
          // По умолчанию возвращаем null
          return Promise.resolve(null);
        },
      };
    });
  });

  test('Полный цикл: логин -> старт -> пауза -> возобновление -> стоп', async ({ page }) => {
    // Шаг 1: Открываем приложение
    await page.goto('/');
    
    // Шаг 2: Проверяем, что видим форму логина
    await expect(page.locator('text=Вход в систему')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    
    // Шаг 3: Заполняем форму логина
    // Мокируем API ответ для логина
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
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
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
    
    // Мокируем API для активных time entries (пустой список)
    await page.route('**/api/time-entries/active', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
    
    // Вводим данные для логина
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'password123');
    
    // Нажимаем кнопку входа
    await page.click('button:has-text("Войти")');
    
    // Шаг 4: Ждем успешного логина и появления селектора проектов
    await expect(page.locator('text=Выберите проект для начала отслеживания')).toBeVisible({ timeout: 5000 });
    
    // Шаг 5: Выбираем проект
    // Мокируем API для старта time entry
    let timeEntryId = 'test-time-entry-id';
    let startTime = new Date().toISOString();
    let duration = 0;
    
    // Мокируем heartbeat API (вызывается после старта)
    await page.route('**/api/idle/heartbeat', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          timestamp: new Date().toISOString(),
        }),
      });
    });
    
    await page.route('**/api/time-entries', async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = await request.postDataJSON();
        timeEntryId = 'test-time-entry-id';
        startTime = new Date().toISOString();
        duration = 0;
        
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: timeEntryId,
            userId: 'test-user-id',
            projectId: body.projectId,
            startTime: startTime,
            endTime: null,
            duration: duration,
            description: body.description || '',
            status: 'RUNNING',
            createdAt: startTime,
            updatedAt: startTime,
            project: {
              id: body.projectId,
              name: 'Test Project',
              color: '#FF5733',
            },
          }),
        });
      }
    });
    
    // Кликаем на проект в селекторе
    // Сначала открываем селектор (SelectTrigger)
    await page.click('[role="combobox"]', { timeout: 5000 });
    // Ждем появления выпадающего списка
    await page.waitForSelector('[role="option"]', { timeout: 5000 });
    // Затем кликаем на проект в выпадающем списке
    await page.click('[role="option"]:has-text("Test Project")', { timeout: 5000 });
    
    // Шаг 6: Нажимаем кнопку "Старт"
    // Ждем, пока кнопка станет кликабельной
    await page.waitForSelector('button:has-text("Старт"):not([disabled])', { timeout: 5000 });
    await page.click('button:has-text("Старт")');
    
    // Шаг 7: Проверяем, что трекинг начался
    // Ждем обновления состояния после API запроса
    // Проверяем, что кнопка "Старт" исчезла или стала disabled
    await page.waitForFunction(
      () => {
        const startButton = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent?.includes('Старт')
        );
        return !startButton || startButton.hasAttribute('disabled');
      },
      { timeout: 10000 }
    );
    
    // Проверяем наличие кнопок управления
    await expect(page.locator('button:has-text("Пауза")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Стоп")')).toBeVisible();
    
    // Шаг 8: Проверяем, что таймер показывает время (хотя бы 00:00:00)
    const timerDisplay = page.locator('.text-4xl.font-mono');
    await expect(timerDisplay).toBeVisible();
    
    // Ждем немного, чтобы время обновилось
    await page.waitForTimeout(2000);
    
    // Шаг 9: Нажимаем "Пауза"
    // Мокируем API для паузы
    await page.route(`**/api/time-entries/${timeEntryId}/pause`, async route => {
      duration = 5; // Симулируем 5 секунд работы
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: timeEntryId,
          userId: 'test-user-id',
          projectId: 'test-project-id',
          startTime: startTime,
          endTime: null,
          duration: duration,
          description: '',
          status: 'PAUSED',
          createdAt: startTime,
          updatedAt: new Date().toISOString(),
          project: {
            id: 'test-project-id',
            name: 'Test Project',
            color: '#FF5733',
          },
        }),
      });
    });
    
    await page.click('button:has-text("Пауза")');
    
    // Шаг 10: Проверяем, что трекинг приостановлен
    await expect(page.locator('text=Приостановлено')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("Возобновить")')).toBeVisible();
    
    // Шаг 11: Нажимаем "Возобновить"
    // Мокируем API для возобновления
    await page.route(`**/api/time-entries/${timeEntryId}/resume`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: timeEntryId,
          userId: 'test-user-id',
          projectId: 'test-project-id',
          startTime: startTime,
          endTime: null,
          duration: duration,
          description: '',
          status: 'RUNNING',
          createdAt: startTime,
          updatedAt: new Date().toISOString(),
          project: {
            id: 'test-project-id',
            name: 'Test Project',
            color: '#FF5733',
          },
        }),
      });
    });
    
    await page.click('button:has-text("Возобновить")');
    
    // Шаг 12: Проверяем, что трекинг возобновлен
    await expect(page.locator('text=Отслеживается')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("Пауза")')).toBeVisible();
    
    // Шаг 13: Нажимаем "Стоп"
    // Мокируем API для остановки
    await page.route(`**/api/time-entries/${timeEntryId}/stop`, async route => {
      duration = 10; // Симулируем 10 секунд работы
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: timeEntryId,
          userId: 'test-user-id',
          projectId: 'test-project-id',
          startTime: startTime,
          endTime: new Date().toISOString(),
          duration: duration,
          description: '',
          status: 'STOPPED',
          createdAt: startTime,
          updatedAt: new Date().toISOString(),
          project: {
            id: 'test-project-id',
            name: 'Test Project',
            color: '#FF5733',
          },
        }),
      });
    });
    
    // Мокируем API для отправки URL activities
    await page.route('**/api/url-activity/batch', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 0,
          skipped: 0,
          activities: [],
        }),
      });
    });
    
    await page.click('button:has-text("Стоп")');
    
    // Шаг 14: Проверяем, что трекинг остановлен
    await expect(page.locator('text=Не запущено')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("Старт")')).toBeVisible();
    
    // Шаг 15: Проверяем, что время все еще отображается (после стопа)
    await expect(timerDisplay).toBeVisible();
    
    // Шаг 16: Проверяем, что время сохранилось в localStorage для накопления
    const savedTime = await page.evaluate(() => {
      return localStorage.getItem('hubnity_accumulatedTime');
    });
    expect(savedTime).toBeTruthy();
    const savedTimeValue = parseInt(savedTime || '0', 10);
    expect(savedTimeValue).toBeGreaterThanOrEqual(0);
  });

  test('Проверка валидации формы логина', async ({ page }) => {
    await page.goto('/');
    
    // Пытаемся отправить пустую форму
    await page.click('button:has-text("Войти")');
    
    // Проверяем, что поля обязательны (HTML5 validation)
    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');
    
    // Проверяем required атрибуты
    await expect(emailInput).toHaveAttribute('required');
    await expect(passwordInput).toHaveAttribute('required');
    
    // Пытаемся ввести невалидный email
    await page.fill('input[type="email"]', 'invalid-email');
    await page.fill('input[type="password"]', 'password');
    
    // Проверяем, что email невалиден (HTML5 validation)
    const emailValidity = await emailInput.evaluate((el: HTMLInputElement) => el.validity.valid);
    expect(emailValidity).toBe(false);
  });

  test('Проверка обработки ошибки логина', async ({ page }) => {
    await page.goto('/');
    
    // Мокируем ошибку API
    await page.route('**/api/auth/login', async route => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Неверный email или пароль',
        }),
      });
    });
    
    // Вводим данные
    await page.fill('input[type="email"]', 'test@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    
    // Нажимаем кнопку входа
    await page.click('button:has-text("Войти")');
    
    // Проверяем, что появилось сообщение об ошибке
    // Может быть в разных форматах, проверяем оба варианта
    const errorMessage = page.locator('.text-destructive, [class*="destructive"]').first();
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
    // Проверяем, что текст содержит информацию об ошибке
    const errorText = await errorMessage.textContent();
    expect(errorText).toBeTruthy();
    expect(errorText?.length).toBeGreaterThan(0);
    
    // Проверяем, что форма все еще видна (не произошел переход)
    await expect(page.locator('text=Вход в систему')).toBeVisible();
  });
});
