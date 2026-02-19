# Технический аудит: Rust + Tauri

**Дата:** 2025  
**Область:** Bridge (Commands), State Management, Error Handling, Resource Leaks, Sync vs Async

---

## 1. Критические баги

### 1.1 Утечка Event Listener в Timer.tsx (Resource Leak)

**Файл:** `src/components/Timer.tsx`  
**Проблема:** `listen()` возвращает Promise. Если компонент размонтируется до разрешения Promise, `unlistenTimer` остаётся `null`, и cleanup не вызывает `unlisten()`. Слушатель `timer-state-update` не отписывается.

```tsx
// Текущий код — утечка при быстром unmount
listen<TimerStateResponse>('timer-state-update', (ev) => { ... }).then((fn) => {
  unlistenTimer = fn;  // Если unmount произошёл до .then(), fn никогда не вызовется
});
// ...
return () => {
  unlistenTimer?.();  // unlistenTimer === null при раннем unmount
};
```

**Исправление:**

```tsx
useEffect(() => {
  let isMounted = true;
  let unlistenTimer: (() => void) | null = null;
  let cancelled = false;

  listen<TimerStateResponse>('timer-state-update', (ev) => {
    if (!isMounted) return;
    // ...
  }).then((fn) => {
    if (cancelled) {
      fn(); // Сразу отписаться, если уже unmount
    } else {
      unlistenTimer = fn;
    }
  });

  return () => {
    isMounted = false;
    cancelled = true;
    unlistenTimer?.();
  };
}, [POLL_MS]);
```

---

### 1.2 Утечка Event Listener в App.tsx (db-recovered-from-corruption)

**Файл:** `src/App.tsx` (строки 543–556)  
**Проблема:** Аналогичная — `unlisten` устанавливается в `.then()`. При unmount до разрешения Promise cleanup не срабатывает.

**Исправление:**

```tsx
useEffect(() => {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  listen('db-recovered-from-corruption', () => {
    setDbRecoveredBannerVisible(true);
    invoke('show_notification', { ... }).catch(() => {});
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}, []);
```

---

### 1.3 Потенциальный panic в engine/db.rs

**Файл:** `src-tauri/src/engine/db.rs` (строка 116)  
**Проблема:** `SystemTime::now().duration_since(UNIX_EPOCH).unwrap()` может вызвать panic, если системное время до 1970 года.

**Исправление:**

```rust
let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|e| format!("System time error: {}", e))?
    .as_secs();
```

---

## 2. Таблица соответствия типов Rust ↔ TypeScript

| Команда | Rust параметры | TS вызов | Статус |
|---------|----------------|----------|--------|
| `set_auth_tokens` | `access_token`, `refresh_token`, `user_id` (Option) | `accessToken`, `refreshToken`, `userId` | ✅ Tauri camelCase→snake_case |
| `persist_time_entry_id` | `id: Option<String>` | `{ id: string \| null }` | ✅ |
| `mark_task_sent_by_id` | `id: i64` | `{ id: queueId }` (number) | ✅ |
| `update_idle_state` | `idle_pause_start_time`, `idle_pause_start_perf_ref`, `is_loading`, `last_activity_time`, `last_activity_perf_ref`, `project_name` | camelCase | ✅ |
| `pause_timer_idle` | `work_elapsed_secs: u64` | `{ workElapsedSecs }` | ✅ |
| `upload_screenshot` | `png_data`, `time_entry_id`, `access_token`, `refresh_token` | camelCase | ✅ |
| `enqueue_time_entry` | `operation`, `payload`, `access_token`, `refresh_token` | camelCase | ✅ |
| `get_sync_queue_stats` | — | — | ✅ `QueueStats` |
| `get_failed_tasks` | `limit: Option<i32>` | `{ limit: 50 }` | ✅ |
| `retry_failed_tasks` | `limit: Option<i32>` | `{ limit: 100 }` | ✅ |
| `get_tray_icon_path` | `state: &str` | `{ state: state.state }` | ✅ |
| `api.ts set_auth_tokens` (refresh) | `user_id: Option<String>` | Не передаётся `userId` | ✅ Ожидаемо — только refresh токенов |

**Вывод:** Tauri по умолчанию конвертирует camelCase (JS) в snake_case (Rust). Расхождений типов не обнаружено.

---

## 3. State Management и Deadlocks

### 3.1 ActivityMonitor (Mutex в async)

**Файл:** `src-tauri/src/commands.rs`, `monitor.rs`  
**Анализ:** Lock берётся на короткое время, `await` под lock не вызывается. В `start_activity_monitoring` lock освобождается до `tokio::spawn`. В spawned task lock берётся только для проверки `is_monitoring` и обновления `last_activity`, затем сразу освобождается перед `sleep().await`. **Deadlock не ожидается.**

### 3.2 TimerEngine (несколько Mutex)

**Файл:** `src-tauri/src/engine/core.rs`  
**Порядок блокировок:** `state` → `day_start_timestamp` или `accumulated_seconds`. Порядок соблюдён, вложенных блокировок с обратным порядком нет. **Deadlock не ожидается.**

### 3.3 Database (Mutex<Connection>)

**Файл:** `src-tauri/src/database.rs`  
**Анализ:** `lock_conn()` обрабатывает poisoned mutex. Lock не держится через `await` (синхронные вызовы). **Корректно.**

### 3.4 SyncManager

**Файл:** `src-tauri/src/sync/mod.rs`  
**Анализ:** Используется `AtomicBool` для single-flight, без Mutex в hot path. **Корректно.**

---

## 4. Error Handling

### 4.1 Команды возвращают Result

Все `#[tauri::command]` возвращают `Result<T, String>` или `Result<(), String>`. Ошибки сериализуются и доходят до фронтенда.

### 4.2 panic! / unwrap / expect в production

| Файл | Строка | Контекст | Рекомендация |
|------|--------|----------|--------------|
| `lib.rs` | 401 | `expect("error while running tauri application")` | Оставить — финальная точка входа |
| `sync/mod.rs` | 389 | `strip_prefix(...).expect(...)` | Защищено `starts_with` — безопасно |
| `engine/db.rs` | 108 | `saved_started_at.unwrap()` | Внутри `if saved_started_at.is_some()` — безопасно |
| `engine/db.rs` | 116 | `duration_since(...).unwrap()` | Заменить на `map_err` (см. п. 1.3) |
| `monitor.rs` | 25–36 | `expect("Mutex poisoned")` | Только в `#[cfg(test)]` — ок |
| `tests.rs` | множество | `unwrap`/`expect` | Только в тестах — ок |

---

## 5. Resource Leaks

### 5.1 Event Listeners

| Компонент | Событие | Cleanup | Статус |
|-----------|---------|---------|--------|
| Timer.tsx | `timer-state-update` | `unlistenTimer?.()` | ❌ Утечка при раннем unmount (см. п. 1.1) |
| App.tsx | `db-recovered-from-corruption` | `unlisten?.()` | ❌ Утечка (см. п. 1.2) |
| App.tsx | `activity-detected` | `unlistenRef.current?.()` | ✅ await + isCleanedUp |
| App.tsx | `resume-tracking`, `stop-tracking` | `unlistenResume()`, `unlistenStop()` | ✅ await + cleanup |
| App.tsx | `request-idle-state-for-idle-window` | `stateRequestCleanupRef` | ✅ Проверка mounted |
| IdleWindow.tsx | `idle-state-update` | `unlistenRef.current?.()` | ✅ await + cancelledRef |

### 5.2 Соединения и дескрипторы

- **Database:** `rusqlite::Connection` — один экземпляр на всё приложение, закрывается при выходе.
- **reqwest::Client:** переиспользуется в SyncManager.
- **Файловые операции:** нет явных незакрытых файлов.

---

## 6. Sync vs Async

### 6.1 Блокирующие операции

| Команда | Реализация | Оценка |
|---------|------------|--------|
| `take_screenshot` | `tokio::task::spawn_blocking` | ✅ Не блокирует executor |
| `get_timer_state` | Синхронный `engine.get_state()` в async команде | ⚠️ Краткая блокировка Mutex (~мкс) — приемлемо |
| `get_tray_icon_path` | Синхронный `path.resolve()` + `exists()` | ⚠️ Файловая система — обычно быстро |
| `get_sleep_gap_threshold_minutes` | Синхронный доступ к БД | ⚠️ Краткая блокировка — приемлемо |

### 6.2 Рекомендации

1. **get_timer_state:** оставить как есть — lock очень короткий.
2. **get_tray_icon_path:** при необходимости можно кэшировать результат в памяти.
3. **Тяжёлые операции:** `take_screenshot` уже использует `spawn_blocking` — корректно.

---

## 7. Рекомендации по оптимизации

### 7.1 Производительность

1. **Timer poll vs emit:** Timer.tsx опирается на `timer-state-update` (200 ms) и дополнительно поллит `get_timer_state` каждые 2–5 с. Можно уменьшить частоту полла при активном RUNNING/PAUSED (emit уже даёт актуальное состояние).
2. **Кэш tray icon:** `get_tray_icon_path` вызывается при каждом обновлении состояния. Можно кэшировать путь по `state` (RUNNING/PAUSED/STOPPED).

### 7.2 Надёжность

1. **Кастомный тип ошибок:** вместо `Result<T, String>` рассмотреть `Result<T, AppError>` с `#[derive(Serialize)]` для структурированных ошибок на фронте.
2. **Логирование:** добавить `RUST_LOG=hubnity=debug` в документацию для отладки.

---

## 8. Итоговая сводка

| Категория | Критичные | Средние | Низкие |
|-----------|-----------|---------|--------|
| Баги | 2 (утечки listeners) | 1 (panic в db) | 0 |
| Типы Rust↔TS | 0 | 0 | 0 |
| Deadlocks | 0 | 0 | 0 |
| Resource Leaks | 2 | 0 | 0 |
| Sync/Async | 0 | 0 | 2 (минор) |

**Приоритет исправлений:**  
1. Timer.tsx и App.tsx — утечки listeners (п. 1.1, 1.2).  
2. engine/db.rs — замена `unwrap` на `map_err` (п. 1.3).

---

## 9. Дополнительный аудит (Z-Index, Payload, Poisoned Mutex)

### 9.1 Z-Index & Focus: IdleWindow и системные уведомления

**Конфигурация:** `tauri.conf.json` — окно `idle` имеет `alwaysOnTop: true`.

**Проблема:** При `alwaysOnTop: true` IdleWindow остаётся поверх обычных окон. На macOS системные уведомления (Notification Center) обычно показываются в правом верхнем углу. Если IdleWindow появляется асинхронно (после `show_idle_window` → 1s delay → `update_idle_state`), оно может перекрывать:
- уведомления приложения (например, «Tracker paused»);
- системные уведомления (календарь, почта и т.п.).

**Текущий flow:** `checkIdleStatus` → `pause` → `invoke('show_idle_window')` → `setTimeout(1000)` → `update_idle_state`. Окно показывается **до** отправки состояния, но после паузы — пользователь успевает увидеть уведомление «Tracker paused» перед появлением IdleWindow.

**Рекомендации:**
1. **Оставить `alwaysOnTop: true`** — это нужно, чтобы IdleWindow не терялось за другими окнами. Пользователь должен явно нажать Resume/Stop.
2. **Порядок вызовов:** Сейчас `show_notification` вызывается **после** `show_idle_window` и 1s delay. Если уведомление показывается после IdleWindow, оно может оказаться под ним. Рекомендуется вызывать `show_notification` **до** `show_idle_window`, чтобы уведомление успело показаться первым.
3. **Опционально:** Добавить `alwaysOnTop: false` в настройках для пользователей, которые хотят видеть уведомления поверх IdleWindow (потребует runtime-изменения окна).

**Рекомендуемое изменение:**

```ts
// В useTrackerStore.ts: сначала уведомление, потом окно
await invoke('show_notification', {
  title: 'Tracker paused',
  body: `No activity for more than ${idleThreshold} minutes`,
});
await invoke('show_idle_window');
// ... delay и update_idle_state
```

---

### 9.2 Payload Serialization: upload_screenshot и enqueue_time_entry

#### upload_screenshot — тяжёлые бинарные данные

**Текущая реализация:** `pngData: Vec<u8>` передаётся через `invoke` как `Array.from(screenshotData)` — массив чисел в JSON.

**Проблема:** Tauri 2 использует JSON‑сериализацию для IPC. `Vec<u8>` → `[1, 2, 3, ...]` в JSON. Для ~300KB JPEG это ~1.2–1.8MB JSON (каждое число ≈ 4–6 символов). Множественные копии при сериализации/десериализации.

**enqueue_time_entry:** `payload: serde_json::Value` — только JSON (start/stop/pause/resume). Обычно 10–100 байт. Без проблем.

**Реализовано (commands.rs):**

- **take_screenshot_to_temp:** путь формируется через `app.path().resolve(filename, BaseDirectory::Temp)` — системная временная папка, не корень проекта.
- **upload_screenshot_from_path:** после чтения и enqueue выполняется гарантированное удаление в конце команды (вне зависимости от Ok/Err):

```rust
// Guaranteed cleanup: always remove temp file whether success or failure
if path.exists() {
    if let Err(e) = tokio::fs::remove_file(path).await {
        warn!("[SCREENSHOT] Failed to remove temp file {}: {}", path.display(), e);
    }
}
result
```

Фронтенд использует новый flow как primary; при ошибке `take_screenshot_to_temp` — fallback на `take_screenshot` + `upload_screenshot` (bytes).

**Альтернатива — Base64:** Меньше, чем `number[]`, но всё ещё JSON. ~400KB для 300KB. Приемлемо, если не хочется менять API.

---

### 9.3 Poisoned Mutex Recovery: engine/db.rs

**Текущая обработка:**

```rust
fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, rusqlite::Error> {
    self.conn.lock().map_err(|e| {
        InvalidParameterName(format!(
            "Database mutex poisoned: {}. This indicates a panic occurred while holding the lock.",
            e
        ))
    })
}
```

**Поведение:** При poisoned mutex возвращается `Err`, вызывающий код пробрасывает через `?`. Приложение не паникует, но операция с БД завершается ошибкой.

**Почему recovery невозможен:** `std::sync::Mutex` при poison не даёт восстановить guard. `lock()` всегда возвращает `Err` после panic. Внутреннее состояние `Connection` неясно (panic мог произойти в середине транзакции). Замена `Connection` потребовала бы замены `Arc<Mutex<Connection>>` на новый экземпляр, что невозможно без `&mut self` у `Database` и пересоздания всей иерархии managed state.

**Оптимальный паттерн для проекта:**

1. **Оставить текущую логику** — возвращать `Err`, не пытаться восстанавливать poisoned mutex.
2. **Улучшить сообщение:** добавить рекомендацию перезапустить приложение.

```rust
fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, rusqlite::Error> {
    self.conn.lock().map_err(|e| {
        InvalidParameterName(format!(
            "Database mutex poisoned: {}. A panic occurred while holding the lock. \
             Please restart the application to recover.",
            e
        ))
    })
}
```

3. **Логирование:** при первом poisoned lock логировать `error!` и, при желании, показывать уведомление пользователю.

4. **Дальнейшие шаги (если нужен recovery):**  
   - Использовать `parking_lot::Mutex` с `PoisonError` или `Arc<Mutex<Option<Connection>>>` и заменой при poison — сложно и рискованно.  
   - Для desktop‑приложения обычно достаточно: ошибка → логирование → уведомление → перезапуск.
