# Time Tracker Implementation

## Реализованный функционал

### 1. Аутентификация
- Форма входа с валидацией
- Сохранение токенов в localStorage
- Защита маршрутов

### 2. Управление проектами
- Получение списка проектов с backend
- Выбор проекта для трекинга
- Отображение проектов с цветовыми индикаторами

### 3. Трекер времени
- **Старт**: Запуск трекера с выбранным проектом
- **Пауза**: Приостановка трекера
- **Resume**: Возобновление трекера
- **Стоп**: Остановка трекера
- Отображение времени в формате HH:MM:SS

### 4. Мониторинг активности
- Отслеживание активности мыши и клавиатуры через Rust
- Отправка heartbeat на backend каждую минуту
- Автоматическая пауза при неактивности более N минут (по умолчанию 2)

### 5. Скриншоты
- Автоматическое создание скриншотов каждые 10 минут
- Отправка скриншотов на backend API

### 6. Уведомления
- Системные уведомления через Tauri
- Уведомления о паузе из-за неактивности

### 7. Настройки
- Настройка порога неактивности
- Отображение профиля пользователя
- Выход из системы

## Структура проекта

```
src/
├── components/
│   ├── ui/          # shadcn/ui компоненты
│   ├── Login.tsx
│   ├── ProjectSelector.tsx
│   ├── Timer.tsx
│   └── Settings.tsx
├── lib/
│   ├── api.ts       # API клиент
│   └── utils.ts     # Утилиты
├── store/
│   ├── useAuthStore.ts
│   └── useTrackerStore.ts
└── App.tsx

src-tauri/
└── src/
    └── lib.rs       # Rust команды
```

## API Endpoints

- `POST /api/auth/login` - Авторизация
- `GET /api/projects` - Список проектов
- `POST /api/time-entries` - Старт трекера
- `POST /api/time-entries/{id}/pause` - Пауза
- `POST /api/time-entries/{id}/resume` - Возобновление
- `POST /api/time-entries/{id}/stop` - Стоп
- `POST /api/idle/heartbeat` - Heartbeat активности
- `POST /api/screenshots` - Загрузка скриншотов

## Rust команды

- `start_activity_monitoring` - Запуск мониторинга активности
- `stop_activity_monitoring` - Остановка мониторинга
- `take_screenshot` - Создание скриншота
- `show_notification` - Показ уведомления

## Запуск проекта

```bash
# Установка зависимостей
pnpm install

# Запуск в режиме разработки
pnpm tauri dev

# Сборка
pnpm tauri build
```

## Технологии

- **Frontend**: React + TypeScript + TailwindCSS + shadcn/ui
- **Backend**: Tauri (Rust)
- **State Management**: Zustand
- **HTTP Client**: Axios

