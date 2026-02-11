import { Page, expect } from '@playwright/test';

/**
 * Общий helper для E2E тестов Hubnity
 * 
 * Содержит функции для:
 * - Настройки моков Tauri команд
 * - Настройки моков API
 * - Выполнения логина
 * - Выбора проекта
 */

export type TimeEntryStatus = 'RUNNING' | 'PAUSED' | 'STOPPED';

/**
 * Настройка моков для Tauri команд
 */
export async function setupTauriMocks(page: Page) {
  await page.addInitScript(() => {
    // Мок состояния таймера
    // ВАЖНО: session_start должен быть null для STOPPED состояния согласно TimerStateResponse типу
    let mockTimerState: any = {
      state: 'STOPPED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null, // Для STOPPED должно быть null
      day_start: Math.floor(Date.now() / 1000),
    };

    // Мок для хранения текущего user_id
    let currentUserId: string | null = null;
    
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: any) => {
        if (cmd === 'get_timer_state') {
          return Promise.resolve(mockTimerState);
        }
        
        if (cmd === 'start_timer') {
          mockTimerState = {
            state: 'RUNNING',
            started_at: Date.now() / 1000,
            elapsed_seconds: 0,
            accumulated_seconds: mockTimerState.accumulated_seconds || 0,
            session_start: Date.now() / 1000,
            day_start: mockTimerState.day_start || Math.floor(Date.now() / 1000),
          };
          return Promise.resolve(mockTimerState);
        }
        
        if (cmd === 'pause_timer') {
          if (mockTimerState.state === 'RUNNING') {
            mockTimerState = {
              state: 'PAUSED',
              elapsed_seconds: 0,
              accumulated_seconds: (mockTimerState.accumulated_seconds || 0) + (mockTimerState.elapsed_seconds || 0),
              session_start: null,
              day_start: mockTimerState.day_start || Math.floor(Date.now() / 1000),
            };
          }
          return Promise.resolve(mockTimerState);
        }
        
        if (cmd === 'resume_timer') {
          if (mockTimerState.state === 'PAUSED') {
            mockTimerState = {
              state: 'RUNNING',
              started_at: Date.now() / 1000,
              elapsed_seconds: 0,
              accumulated_seconds: mockTimerState.accumulated_seconds || 0,
              session_start: Date.now() / 1000,
              day_start: mockTimerState.day_start || Math.floor(Date.now() / 1000),
            };
          }
          return Promise.resolve(mockTimerState);
        }
        
        if (cmd === 'stop_timer') {
          mockTimerState = {
            state: 'STOPPED',
            elapsed_seconds: 0,
            accumulated_seconds: (mockTimerState.accumulated_seconds || 0) + (mockTimerState.elapsed_seconds || 0),
            session_start: null,
            day_start: mockTimerState.day_start || Math.floor(Date.now() / 1000),
          };
          return Promise.resolve(mockTimerState);
        }
        
        // Моки для авторизации (используются в useAuthStore)
        if (cmd === 'get_current_user_id') {
          return Promise.resolve(currentUserId);
        }
        
        if (cmd === 'set_auth_tokens') {
          // Сохраняем user_id из аргументов
          if (args?.userId) {
            currentUserId = args.userId;
          } else if (args?.userId === null || args?.userId === undefined) {
            currentUserId = null;
          }
          return Promise.resolve();
        }
        
        // Моки для App.tsx инициализации
        if (cmd === 'get_app_version') {
          return Promise.resolve('0.1.8');
        }
        
        if (cmd === 'sync_queue_now') {
          return Promise.resolve(0); // Возвращаем количество синхронизированных задач
        }
        
        if (cmd === 'log_message') {
          return Promise.resolve();
        }
        
        if (cmd === 'plugin:tray|set_tooltip') {
          return Promise.resolve();
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
        
        // Дополнительные команды для других тестов
        if (cmd === 'enqueue_time_entry') {
          return Promise.resolve();
        }
        
        if (cmd === 'request_screenshot_permission') {
          return Promise.resolve(true);
        }
        
        if (cmd === 'plugin:tray|new') {
          return Promise.resolve();
        }
        
        if (cmd === 'show_notification') {
          return Promise.resolve();
        }
        
        return Promise.resolve({});
      },
    };
  });
}

/**
 * Настройка моков для API вызовов
 */
export function setupApiMocks(
  page: Page,
  options: {
    getCurrentTimeEntryStatus?: () => TimeEntryStatus;
    onTimeEntryStatusChange?: (status: TimeEntryStatus) => void;
  } = {}
) {
  const { getCurrentTimeEntryStatus = () => 'STOPPED', onTimeEntryStatusChange } = options;
  
  // Мокируем API для логина
  page.route('**/api/auth/login', async route => {
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

  // Мокируем API для проектов
  page.route('**/api/projects', async route => {
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
  page.route('**/api/time-entries/active', async route => {
    const status = getCurrentTimeEntryStatus();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        status !== 'STOPPED' ? [
          {
            id: 'test-time-entry-id',
            userId: 'test-user-id',
            projectId: 'test-project-id',
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            description: '',
            status: status,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            project: {
              id: 'test-project-id',
              name: 'Test Project',
              color: '#FF5733',
            },
          },
        ] : []
      ),
    });
  });
  
  // Мокируем API для pause time entry
  page.route('**/api/time-entries/*/pause', async route => {
    if (onTimeEntryStatusChange) {
      onTimeEntryStatusChange('PAUSED');
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'test-time-entry-id',
        userId: 'test-user-id',
        projectId: 'test-project-id',
        startTime: new Date().toISOString(),
        endTime: null,
        duration: 0,
        description: '',
        status: 'PAUSED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        project: {
          id: 'test-project-id',
          name: 'Test Project',
          color: '#FF5733',
        },
      }),
    });
  });
  
  // Мокируем API для resume time entry
  page.route('**/api/time-entries/*/resume', async route => {
    if (onTimeEntryStatusChange) {
      onTimeEntryStatusChange('RUNNING');
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'test-time-entry-id',
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
  });
  
  // Мокируем API для stop time entry
  page.route('**/api/time-entries/*/stop', async route => {
    if (onTimeEntryStatusChange) {
      onTimeEntryStatusChange('STOPPED');
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'test-time-entry-id',
        userId: 'test-user-id',
        projectId: 'test-project-id',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        duration: 0,
        description: '',
        status: 'STOPPED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        project: {
          id: 'test-project-id',
          name: 'Test Project',
          color: '#FF5733',
        },
      }),
    });
  });
  
  // Мокируем API для старта time entry
  page.route('**/api/time-entries', async route => {
    if (route.request().method() === 'POST') {
      if (onTimeEntryStatusChange) {
        onTimeEntryStatusChange('RUNNING');
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'test-time-entry-id',
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
      return;
    }
    await route.fulfill({ status: 200, body: '{}' });
  });

  // Мокируем heartbeat API
  page.route('**/api/idle/heartbeat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
      }),
    });
  });
}

/**
 * Выполняет логин в приложении
 */
export async function login(page: Page, options: {
  email?: string;
  password?: string;
} = {}) {
  const email = options.email || 'test@example.com';
  const password = options.password || 'password123';
  
  // Ждем появления формы логина
  await expect(page.locator('text=Welcome back!')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 5000 });
  
  // Заполняем форму логина
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  
  // Нажимаем кнопку входа
  await page.click('button:has-text("Sign in")');
  
  // Ждем успешного логина - проверяем, что появился ProjectSelector
  await expect(page.locator('text=Choose a project to start tracking')).toBeVisible({ timeout: 10000 });
}

/**
 * Выбирает проект из списка
 */
export async function selectProject(page: Page, projectName: string = 'Test Project') {
  await page.click('[role="combobox"]', { timeout: 5000 });
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  await page.click(`[role="option"]:has-text("${projectName}")`, { timeout: 5000 });
  
  // Ждем, пока проект выберется в store и компонент Timer обновится
  // Сначала проверяем, что текст "Choose a project to start tracking" исчез
  await page.waitForFunction(
    () => {
      const chooseProjectText = document.body.textContent?.includes('Choose a project to start tracking');
      return !chooseProjectText;
    },
    { timeout: 15000 }
  ).catch(() => {
    // Игнорируем, если текст не найден (может быть уже исчез)
  });
  
  // Затем ждем, пока компонент Timer загрузится и покажет кнопки
  await page.waitForFunction(
    () => {
      // Проверяем, что либо есть кнопка Start, либо есть кнопка Pause/Resume (если трекинг уже запущен)
      const startButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Start') && !btn.hasAttribute('disabled')
      );
      const pauseButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Pause')
      );
      const resumeButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent?.includes('Resume')
      );
      // Либо есть Start, либо есть Pause/Resume (трекинг активен)
      return startButton !== undefined || pauseButton !== undefined || resumeButton !== undefined;
    },
    { timeout: 20000 }
  );
}

/**
 * Полная настройка для теста: моки + логин + выбор проекта
 */
export async function setupTest(
  page: Page,
  options: {
    email?: string;
    password?: string;
    projectName?: string;
    getCurrentTimeEntryStatus?: () => TimeEntryStatus;
    onTimeEntryStatusChange?: (status: TimeEntryStatus) => void;
  } = {}
) {
  // Настраиваем моки
  await setupTauriMocks(page);
  setupApiMocks(page, {
    getCurrentTimeEntryStatus: options.getCurrentTimeEntryStatus,
    onTimeEntryStatusChange: options.onTimeEntryStatusChange,
  });
  
  // Переходим на страницу
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  
  // Выполняем логин
  await login(page, {
    email: options.email,
    password: options.password,
  });
  
  // Выбираем проект (если указан)
  if (options.projectName !== undefined) {
    await selectProject(page, options.projectName);
    // selectProject уже ждет загрузки компонента Timer, дополнительное ожидание не нужно
  }
}
