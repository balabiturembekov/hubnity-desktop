# E2E Test Helpers

Общие helper функции для упрощения написания и поддержки E2E тестов.

## Использование

### Базовый пример

```typescript
import { test, expect } from '@playwright/test';
import { setupTest, selectProject } from './helpers';

test.describe('My Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Полная настройка: моки + логин + выбор проекта
    await setupTest(page, {
      projectName: 'Test Project', // Опционально - выбрать проект автоматически
    });
  });

  test('my test', async ({ page }) => {
    // Тест уже залогинен и проект выбран
    // Можно сразу начинать тестировать функциональность
  });
});
```

### Пример с отслеживанием статуса time entry

```typescript
import { test, expect } from '@playwright/test';
import { setupTest, type TimeEntryStatus } from './helpers';

test.describe('Timer Tests', () => {
  let currentTimeEntryStatus: TimeEntryStatus = 'STOPPED';

  test.beforeEach(async ({ page }) => {
    await setupTest(page, {
      getCurrentTimeEntryStatus: () => currentTimeEntryStatus,
      onTimeEntryStatusChange: (status) => {
        currentTimeEntryStatus = status;
      },
    });
  });

  test('timer operations', async ({ page }) => {
    // Статус автоматически обновляется при операциях pause/resume/stop
  });
});
```

### Пример без автоматического выбора проекта

```typescript
import { test, expect } from '@playwright/test';
import { setupTest, selectProject } from './helpers';

test.describe('My Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Настройка без автоматического выбора проекта
    await setupTest(page);
  });

  test('my test', async ({ page }) => {
    // Выбираем проект вручную в тесте
    await selectProject(page, 'My Project');
  });
});
```

## Доступные функции

### `setupTest(page, options?)`

Полная настройка для теста:
- Настраивает моки Tauri команд
- Настраивает моки API
- Выполняет логин
- Опционально выбирает проект

**Параметры:**
- `email?: string` - Email для логина (по умолчанию: 'test@example.com')
- `password?: string` - Пароль для логина (по умолчанию: 'password123')
- `projectName?: string` - Название проекта для автоматического выбора
- `getCurrentTimeEntryStatus?: () => TimeEntryStatus` - Функция для получения текущего статуса
- `onTimeEntryStatusChange?: (status: TimeEntryStatus) => void` - Callback при изменении статуса

### `login(page, options?)`

Выполняет логин в приложении.

**Параметры:**
- `email?: string` - Email (по умолчанию: 'test@example.com')
- `password?: string` - Пароль (по умолчанию: 'password123')

### `selectProject(page, projectName?)`

Выбирает проект из списка.

**Параметры:**
- `projectName?: string` - Название проекта (по умолчанию: 'Test Project')

### `setupTauriMocks(page)`

Настраивает моки для Tauri команд (автоматически вызывается в `setupTest`).

### `setupApiMocks(page, options?)`

Настраивает моки для API вызовов (автоматически вызывается в `setupTest`).

## Что мокируется

### Tauri команды:
- `get_timer_state` - получение состояния таймера
- `start_timer`, `pause_timer`, `resume_timer`, `stop_timer` - операции с таймером
- `get_current_user_id`, `set_auth_tokens` - авторизация
- `get_app_version`, `sync_queue_now` - инициализация
- `log_message`, `plugin:tray|set_tooltip` - логирование и UI
- `start_activity_monitoring`, `stop_activity_monitoring` - мониторинг активности
- `get_active_window_info` - информация об активном окне
- `enqueue_time_entry` - очередь синхронизации
- `request_screenshot_permission` - разрешения
- `show_notification` - уведомления

### API endpoints:
- `POST /api/auth/login` - логин
- `GET /api/projects` - список проектов
- `GET /api/time-entries/active` - активные time entries
- `POST /api/time-entries` - создание time entry
- `POST /api/time-entries/:id/pause` - пауза
- `POST /api/time-entries/:id/resume` - возобновление
- `POST /api/time-entries/:id/stop` - остановка
- `POST /api/idle/heartbeat` - heartbeat

## Миграция существующих тестов

### До:
```typescript
test.beforeEach(async ({ page }) => {
  // 200+ строк кода для настройки моков и логина
  await page.addInitScript(() => { /* ... */ });
  await page.route('**/api/auth/login', async route => { /* ... */ });
  // ... много кода ...
  await page.goto('/');
  await page.fill('input[type="email"]', 'test@example.com');
  // ... еще код ...
});
```

### После:
```typescript
test.beforeEach(async ({ page }) => {
  await setupTest(page, { projectName: 'Test Project' });
});
```
