# Отладка — логи в терминал

## Что выводится в dev

При `pnpm tauri dev` в терминал выводятся:

### API
- **Запросы:** `[API] -> GET /time-entries/active`
- **Ответы:** `[API] <- GET /time-entries/active 200 [2 items] userIds: abc123, def456`
- **Ошибки:** `[API] <- POST /time-entries 500 User already has active entry`

### DEBUG (ключевые решения)
- `[DEBUG:LOAD]` — loadActiveTimeEntry: currentUser, activeEntries, userEntries, foreignEntries, activeEntry
- `[DEBUG:SYNC]` — syncTimerState: currentUser, userEntries, foreignEntries, решения (RESUME/PAUSE/STOP)
- `[DEBUG:STOP]` — stopTracking: entryIdToStop, userId, источник
- `[DEBUG:START]` — startTracking: userId, projectId
- `[DEBUG:PAUSE]` — pauseTracking: entryIdToPause, userId
- `[DEBUG:INVARIANT]` — рассинхрон store ↔ engine

Логирование включено в **dev-режиме** (`import.meta.env.DEV`).

### Включить в production-сборке

В DevTools консоли браузера:

```js
localStorage.setItem('DEBUG', '1');      // DEBUG логи (LOAD, SYNC, STOP, ...)
localStorage.setItem('DEBUG_API', '1');  // API запросы/ответы
```

Перезагрузить приложение. Чтобы отключить: `localStorage.removeItem('DEBUG')`.

## Rust (Tauri)

Для подробных логов Tauri:

```bash
RUST_LOG=debug pnpm tauri dev
# или только sync:
RUST_LOG=hubnity=debug pnpm tauri dev
```

Дополнительно выводятся, например:

- `[SYNC] get_sync_status: pending=0, failed=0, is_online=true`
- `[SYNC] sync_queue_now: 2 pending tasks`
- `[SYNC] sync_queue_now: synced 2 tasks`

## Использование при отладке

1. Запустить `pnpm tauri dev` (и при необходимости `RUST_LOG=debug`).
2. Воспроизвести проблему.
3. Скопировать вывод терминала и передать для анализа.
4. По логам можно проверить: ответы API, userId в active entries, статусы sync и т.п.
