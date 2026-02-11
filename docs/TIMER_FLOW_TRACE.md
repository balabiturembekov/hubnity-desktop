# Трассировка потока: Start → Pause (idle) → Day rollover → Sync

Пошаговый проход по коду для сценария: пользователь запускает таймер, ставит на паузу (например при idle), проходит смена дня, фоновая синхронизация отправляет операции на бэкенд.

---

## 1. Старт таймера (Start)

### 1.1 Frontend → команда

**Файл:** `src/store/useTrackerStore.ts`

- Пользователь нажимает «Старт» в UI.
- Store вызывает `startTracking(description)`.
- Порядок:
  1. **Очередь sync:** `invoke('enqueue_time_entry', { operation: 'start', payload: { projectId, userId, description } })` — задача `time_entry_start` попадает в БД (`database.enqueue_sync`).
  2. **API:** `api.startTimeEntry(requestData)` — прямой запрос на бэкенд (если онлайн).
  3. **Timer Engine:** `TimerEngineAPI.start()` → `invoke('start_timer')`.

### 1.2 Tauri команда → Engine

**Файл:** `src-tauri/src/commands.rs`

```rust
pub async fn start_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.start()?;
    engine.get_state()
}
```

### 1.3 Engine: start()

**Файл:** `src-tauri/src/engine/core.rs`

1. **ensure_correct_day()** — если календарный день сменился с прошлого вызова, вызывается `rollover_day()` (см. раздел 3).
2. **FSM:** переход `Stopped → Running` или `Paused → Running`:
   - Берётся `now_instant = Instant::now()` и `now_timestamp` (Unix).
   - При первом старте за день: `day_start_timestamp = Some(now_timestamp)`.
   - `state = Running { started_at, started_at_instant }`.
3. **Сохранение:** `save_state()` → `engine/db.rs` → `db.save_timer_state(day, accumulated, "running", started_at)`.

### 1.4 Сохранение состояния в БД

**Файл:** `src-tauri/src/engine/db.rs`

- `save_state()` / `save_state_with_accumulated_override()` читает из engine: `state`, `accumulated_seconds`, `day_start_timestamp`.
- Формирует `day` (строка `YYYY-MM-DD` в UTC), `state_str` ("running" | "paused" | "stopped"), `started_at` (для running).
- Вызов `db.save_timer_state(&day, accumulated, state_str, started_at)` — одна запись в таблице состояния таймера.

**Итог старта:** локальный FSM в Running, состояние в БД обновлено, в очереди sync лежит задача `time_entry_start`.

---

## 2. Пауза (Pause, в т.ч. при idle)

### 2.1 Frontend → команда

**Файл:** `src/store/useTrackerStore.ts` — `pauseTracking(isIdlePause)`.

- Порядок:
  1. **Очередь:** `invoke('enqueue_time_entry', { operation: 'pause', payload: { id: currentTimeEntry.id } })` — задача `time_entry_pause`.
  2. **Timer Engine:** `TimerEngineAPI.pause()` → `invoke('pause_timer')`.

### 2.2 Tauri команда → Engine

**Файл:** `src-tauri/src/commands.rs`

```rust
pub async fn pause_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.pause()?;
    engine.get_state()
}
```

### 2.3 Engine: pause()

**Файл:** `src-tauri/src/engine/core.rs`

1. **ensure_correct_day()** — при смене дня выполняется rollover (раздел 3).
2. **FSM:** переход `Running → Paused`:
   - `session_elapsed = Instant::now() - started_at_instant`.
   - `new_accumulated = accumulated + session_elapsed` (с защитой от переполнения).
   - `state = Paused`, `accumulated_seconds = new_accumulated`.
3. **Сохранение:** `save_state_with_accumulated_override(Some(new_accumulated))` → одна транзакция с новым accumulated и `state_str = "paused"`.

**Итог паузы:** FSM в Paused, накопленное время за сессию добавлено в `accumulated_seconds`, в очереди sync — задача `time_entry_pause`.

---

## 3. Смена дня (Day rollover)

### 3.1 Где вызывается

**Файл:** `src-tauri/src/engine/core.rs`

- `ensure_correct_day()` вызывается в начале: `start()`, `pause()`, `stop()`, `get_state()` (и внутри `get_state_internal`).
- Логика:
  - Берётся сохранённый день из `day_start_timestamp` (или текущий день, если не задан).
  - Текущий день: `Utc::now().date_naive()`.
  - Если `saved_day_utc != today_utc` → вызывается `rollover_day(saved_day_utc, today_utc)`.

### 3.2 rollover_day()

**Файл:** `src-tauri/src/engine/core.rs`

1. Если состояние было **Running** (Hubstaff-style):
   - Считается время до полуночи старого дня (`time_until_midnight`), с учётом clock skew.
   - `accumulated_seconds += time_until_midnight` (время «до полуночи» сохраняется для полной длительности при stop).
   - Остаётся **Running**: `state = Running { started_at: midnight, ... }` — таймер продолжает работать.
2. `accumulated_seconds = 0` для нового дня (только если НЕ was_running).
3. `day_start_timestamp = Some(new_day_start)` (полночь нового дня).
4. `save_state()` — новое состояние в БД.

**Итог:** при rollover таймер продолжает работать, «Today» обнуляется и показывает время с полуночи.

---

## 4. Синхронизация очереди (Sync)

### 4.1 Запуск фонового sync

**Файл:** `src-tauri/src/lib.rs` (setup)

- В отдельном потоке создаётся Tokio runtime.
- После паузы 10 с запускается цикл: каждые 60 с вызывается `sync_manager.sync_queue(5)`.
- Команда «синхронизировать сейчас»: `sync_queue_now` → `sync_manager.sync_queue(5)`.

### 4.2 sync_queue()

**Файл:** `src-tauri/src/sync/mod.rs`

1. Блокировка sync (один sync в момент времени).
2. **run_sync_internal(max_retries, batch_size):**
   - `db.get_retry_tasks(max_retries, batch_size)` — задачи с учётом exponential backoff и лимита повторов.
   - Для каждой задачи: `sync_task(id, entity_type, payload, idempotency_key)`.
   - При успешном HTTP: `db.mark_task_sent(id)`; при ошибке — `update_sync_status` (retry или failed).

### 4.3 sync_task() — одна задача

**Файл:** `src-tauri/src/sync/mod.rs`

1. **Токен:** `auth_manager.get_access_token().await`; если нет — возврат ошибки.
2. **Тип задачи:**
   - **time_entry_*** (start | pause | resume | stop):
     - Построение запроса: `send_time_entry_request(operation, payload_json, access_token, idempotency_key)`.
     - URL: start → `POST /time-entries`, pause/resume/stop → `PUT /time-entries/{id}/pause|resume|stop`.
     - Отправка через `self.client` (reqwest).
   - **screenshot:** `send_screenshot_request()` → POST с `imageData`, `timeEntryId`.
3. **При 401:** `auth_manager.refresh_token(refresh).await`, повтор запроса с новым access token.
4. Результат: `Ok(true)` (успех), `Ok(false)` (4xx/5xx), `Err` (сеть/разбор и т.д.).

**Итог sync:** задачи из локальной очереди (time_entry_start, time_entry_pause, screenshot и т.д.) уходят на бэкенд; при 401 токен обновляется и запрос повторяется.

---

## 5. Краткая цепочка вызовов

| Шаг | Действие | Цепочка |
|-----|----------|--------|
| Start | UI → store | `startTracking` → `enqueue_time_entry('start', payload)` → `api.startTimeEntry` → `invoke('start_timer')` |
| Start | Backend | `start_timer` → `engine.start()` → `ensure_correct_day()` → FSM Stopped→Running → `save_state()` |
| Pause | UI → store | `pauseTracking` → `enqueue_time_entry('pause', { id })` → `invoke('pause_timer')` |
| Pause | Backend | `pause_timer` → `engine.pause()` → `ensure_correct_day()` → FSM Running→Paused → `save_state_with_accumulated_override` |
| Day rollover | Внутри engine | Любой `start`/`pause`/`stop`/`get_state` → `ensure_correct_day()` → при смене дня `rollover_day()` → accumulated за старый день, обнуление, save |
| Sync | Background | `sync_queue(5)` → `get_retry_tasks` → для каждой `sync_task` → AuthManager token → HTTP (time_entry / screenshot) → при 401 refresh → `mark_task_sent` |

---

## 6. Важные файлы

| Компонент | Файлы |
|-----------|--------|
| Таймер FSM | `src-tauri/src/engine/mod.rs` (состояния), `src-tauri/src/engine/core.rs` (start/pause/stop/resume, ensure_correct_day, rollover_day) |
| Сохранение состояния | `src-tauri/src/engine/db.rs` (save_state, restore_state) |
| Команды Tauri | `src-tauri/src/commands.rs` (start_timer, pause_timer, stop_timer, get_timer_state, enqueue_time_entry, sync_queue_now) |
| Очередь и sync | `src-tauri/src/sync/mod.rs` (enqueue_time_entry, enqueue_screenshot, sync_queue, sync_task, send_time_entry_request) |
| Auth | `src-tauri/src/auth.rs` (get_access_token, refresh_token); в sync — через AuthManager |
| Frontend store | `src/store/useTrackerStore.ts` (startTracking, pauseTracking, stopTracking; вызовы invoke и TimerEngineAPI) |
| Таймер API (frontend) | `src/lib/timer-engine.ts` (start, pause, resume, stop, getState → invoke) |
