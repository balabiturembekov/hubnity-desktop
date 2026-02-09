# Аудит фронтенда (React + TypeScript + Zustand)

Структура, архитектура, качество кода и тесты.

---

## 1. Структура проекта

```
src/
├── main.tsx              # Точка входа: Sentry, ErrorBoundary, App
├── App.tsx                # Роутинг (табы), restoreTokens, tray, listeners
├── App.css / index.css    # Tailwind + CSS‑переменные (темы)
├── idle.tsx               # Точка входа для idle‑окна (idle.html)
├── components/
│   ├── Login.tsx          # Форма входа, валидация, store.login
│   ├── ProjectSelector.tsx
│   ├── Timer.tsx          # Таймер, getTimerState (1s), resetDay, кнопки
│   ├── TimerWithScreenshots # Timer + ScreenshotsView
│   ├── Settings.tsx       # Порог idle, очередь, выход
│   ├── SyncIndicator.tsx   # Статус синка, FailedTasksDialog
│   ├── IdleWindow.tsx     # Окно «Простой», Resume/Stop → invoke → события
│   ├── ScreenshotsView.tsx # Список скриншотов, store.getScreenshots
│   ├── FailedTasksDialog.tsx
│   ├── ErrorBoundary.tsx   # class component, Sentry, fallback UI
│   └── ui/                 # Radix + CVA (button, card, dialog, input, tabs…)
├── store/
│   ├── useAuthStore.ts     # Zustand + persist, user, login, logout, set_tokens
│   └── useTrackerStore.ts  # projects, currentTimeEntry, start/pause/resume/stop, invoke + api
├── lib/
│   ├── api.ts              # Axios, refresh при 401, set_tokens в Rust
│   ├── timer-engine.ts     # TimerEngineAPI → invoke(start_timer, get_timer_state…)
│   ├── current-user.ts     # setCurrentUser / getCurrentUser (разрыв цикла auth↔tracker)
│   ├── logger.ts           # debug/info/warn/error, Sentry для error
│   ├── sentry.ts           # initSentry, captureException, setSentryUser
│   └── utils.ts            # cn (tailwind-merge)
└── test/setup.ts           # Vitest setup
```

**Сборка:** Vite 7, React 19, TypeScript 5.8, base: `'./'` для Tauri. Два входа: `index.html` (main), `idle.html` (idle).

---

## 2. Зависимости

| Категория | Пакеты |
|-----------|--------|
| UI | React 19, Radix (dialog, select, tabs…), Tailwind, CVA, clsx, tailwind-merge, lucide-react |
| Состояние | Zustand (persist для auth) |
| Сеть | Axios |
| Tauri | @tauri-apps/api, plugin-notification, plugin-opener |
| Мониторинг | @sentry/react |
| Тесты | Vitest, Testing Library, Playwright (e2e) |

---

## 3. Архитектура (Clean Architecture)

| Правило | Соблюдение |
|---------|------------|
| UI → только store | Компоненты вызывают useTrackerStore / useAuthStore; прямых вызовов api в компонентах нет (кроме store, который внутри дергает api + invoke). |
| Разрыв цикла auth↔tracker | current-user.ts: setCurrentUser/getCurrentUser; auth store не вызывает tracker reset; logout вызывает reset в Settings/App. |
| Один source of truth по времени | Timer берёт elapsed из getTimerState (invoke → Rust); store синхронизирует isTracking/isPaused из get_timer_state в Timer (interval 1s). |
| Токены в Rust | set_auth_tokens при логине, logout, restoreTokens (App), после refresh в api interceptor. |

Соответствует заложенной архитектуре.

---

## 4. Ключевые потоки

- **Логин:** Login → useAuthStore.login → api.login → set_tokens (localStorage + Rust) → set(user), setCurrentUser, setSentryUser.
- **Старт:** Store.startTracking → enqueue_time_entry + api.startTimeEntry + TimerEngineAPI.start → set(currentTimeEntry, isTracking).
- **Пауза/стоп/возобновление:** Аналогично: enqueue + api + engine, затем set состояния.
- **Idle:** App (checkIdleStatus) → pauseTracking(isIdlePause: true), show_idle_window; IdleWindow → Resume/Stop → invoke(resume_tracking_from_idle | stop_tracking_from_idle) → события → App слушает → resumeTracking() / stopTracking().
- **Восстановление:** App (loadActiveTimeEntry) при isAuthenticated; store синхронизирует engine с active entry (RUNNING/PAUSED).

---

## 5. Качество кода

| Аспект | Оценка |
|--------|--------|
| TypeScript | strict, noUnusedLocals, noUnusedParameters; типы для API и TimerStateResponse. |
| Логирование | Централизованный logger (context + message), Sentry на error. |
| Ошибки | ErrorBoundary, обработка в формах (Login error state), store.error. |
| Доступность | Кнопки, формы, карточки; можно усилить aria-* где нужно. |
| Безопасность | Login: санитизация сообщения об ошибке (strip tags); пароль не логируется. |

**Замечания:**

- В App.tsx и ProjectSelector.tsx по одному `eslint-disable-next-line react-hooks/exhaustive-deps` — зависимости эффектов намеренно сокращены; при изменении логики стоит перепроверить.
- В App.tsx много логики (activity, URL tracking, idle, heartbeat, listeners) — при росте можно вынести в хуки (например `useActivityListeners`, `useUrlTracking`).

---

## 6. Стили и темы

- Tailwind 3 + CSS-переменные в `index.css` (:root / .dark).
- Цвета таймера: `--timer-running`, `--destructive-soft` и т.д.
- Компоненты ui на Radix + CVA, единообразный вид.

---

## 7. Тесты

| Набор | Статус |
|-------|--------|
| useTrackerStore.test.ts | 11/11 проходят. Ожидания в тестах «handles error when resuming/stopping timer engine» обновлены: при ошибке только движка store обновляет состояние из API (isTracking / currentTimeEntry === null). |
| Login.test.tsx | 5/5 проходят. |
| Timer.test.tsx | 9/9 проходят. Моки вынесены в vi.hoisted(); в мок store добавлен defaultProject, чтобы таймер рендерился. |

**Итого:** 25 тестов проходят (store 11, Timer 9, Login 5).

---

## 8. Соответствие бэкенду

- Состояние таймера: `TimerStateResponse` (STOPPED | RUNNING | PAUSED, elapsed_seconds, day_start…) совпадает с Rust.
- Команды: start_timer, pause_timer, stop_timer, resume_timer, get_timer_state, reset_timer_day, save_timer_state, enqueue_time_entry, set_auth_tokens и др. используются согласованно.
- Очередь и синк: get_sync_status, get_sync_queue_stats, get_failed_tasks, retry_failed_tasks — через invoke в SyncIndicator/Settings.

Логика фронта и бэкенда согласована (см. docs/LOGIC_CONSISTENCY_AUDIT.md).

---

## 9. Итог

| Критерий | Оценка |
|----------|--------|
| Структура | Понятная, разделение components / store / lib. |
| Архитектура | Соответствует Clean Architecture, один source of truth по времени, токены в Rust. |
| Типизация | Строгий TypeScript, типы API и состояния. |
| Ошибки и логи | ErrorBoundary, logger, Sentry. |
| Тесты | Часть unit-тестов падает (2 в store, Timer из-за мока); e2e есть (Playwright). |

**Рекомендации:**

1. Починить падающие тесты: store (ожидания при ошибке resume/stop), Timer (vi.mock/hoisting).
2. При росте App.tsx вынести эффекты (activity, URL, idle, heartbeat) в кастомные хуки.
3. По желанию: расширить aria-* и семантику для кнопок/форм.

В целом фронтенд в хорошем состоянии: структура и архитектура выдержаны, расхождений с бэкендом нет; основное улучшение — стабилизация тестов и при необходимости рефакторинг тяжёлых эффектов в App.
