# Трекер Hubnity — сценарии и зависимости

**Назначение:** единый источник истины для понимания логики трекера. Перед любым изменением в трекере — читать этот документ и проверять затронутые сценарии.

---

## 1. Источники истины

| Что | Где | Примечание |
|-----|-----|------------|
| Состояние таймера (RUNNING/PAUSED/STOPPED) | Rust `TimerEngine` | UI опрашивает `get_timer_state` раз в 1 с |
| Активная запись (time entry) | Сервер API + store | `currentTimeEntry` в store — кэш |
| Выбранный проект | store `selectedProject` | Не персистится при перезагрузке |
| Idle (простой) | store `idlePauseStartTime` + Rust idle window | `idlePauseStartTime !== null` = окно простоя показано |
| Очередь синка | SQLite `sync_queue` | Offline-first: enqueue → sync_queue_now |

---

## 2. Сценарии и цепочки вызовов

### 2.1 Старт таймера

```
Timer.handleStart → store.startTracking()
  → [проверки] selectedProject, user, isLoading
  → api.getActiveTimeEntries() [при ошибке — пустой массив, офлайн]
  → TimerEngineAPI.start() [первым!]
  → set(currentTimeEntry: optimistic, isTracking, isPaused: false)
  → invoke('start_activity_monitoring')
  → [фон] api.startTimeEntry + enqueue → mark_task_sent_by_id
```

**Зависимости:** `selectedProject`, `loadProjects` (для выбора), `getActiveTimeEntries` (офлайн: try/catch → пустой массив).

**При изменении:** проверить офлайн-путь, `mark_task_sent_by_id` при успехе API.

---

### 2.2 Пауза (ручная)

```
Timer.handlePause → store.pauseTracking(isIdlePause: false)
  → TimerEngineAPI.pause() [первым!]
  → [если currentTimeEntry] api.pauseTimeEntry + enqueue
  → set(isPaused: true, idlePauseStartTime: null)
  → invoke('stop_activity_monitoring')
```

**При изменении:** движок паузится первым; при ошибке API — store уже в isPaused, UI согласован.

---

### 2.3 Пауза (idle)

```
App.checkIdleStatus (каждые 10 с)
  → lastActivityTime vs idleThreshold [effectiveThreshold = max(1, idleThreshold)]
  → store.pauseTracking(isIdlePause: true)
  → pause_timer_idle(work_elapsed_secs) — время до lastActivityTime, БЕЗ минут простоя
  → invoke('show_idle_window', { pauseStartTime })
  → IdleWindow рендерится
```

**Важно:** При idle паузе 2 мин простоя НЕ учитываются в accumulated. work_elapsed = (lastActivityTime/1000) - session_start.

**Источники lastActivityTime:**
- Rust `activity-detected` (system idle < 5s) — emit сразу при активности, min_emit_interval 10s
- DOM fallback (mousemove, keydown, …) — только когда фокус на окне Hubnity, throttle 5s

**Константы activity-detected (commands.rs activity_emit):**
| Константа | Значение | Назначение |
|-----------|----------|------------|
| ACTIVITY_THRESHOLD | 5s | idle < 5s = пользователь активен |
| MIN_EMIT_INTERVAL | 10s | не чаще 1 emit в 10s (throttle) |

**При изменении:** DOM fallback в App.tsx; idleThreshold в store (min 1); checkIdleStatus не должен паузить при idlePauseStartTime !== null.

---

### 2.4 Возобновление (из idle)

```
IdleWindow "Продолжить" → invoke('resume_tracking_from_idle')
  → App слушает 'resume-tracking' → store.resumeTracking()
  → api.resumeTimeEntry + enqueue
  → TimerEngineAPI.resume()
  → set(idlePauseStartTime: null)
  → invoke('hide_idle_window'), invoke('start_activity_monitoring')
```

---

### 2.5 Стоп

```
Timer.handleStop → store.stopTracking()
  → api.stopTimeEntry + enqueue
  → TimerEngineAPI.stop()
  → set(currentTimeEntry: null, isTracking: false, isPaused: false, idlePauseStartTime: null)
  → invoke('stop_activity_monitoring'), invoke('hide_idle_window')
```

---

### 2.6 Восстановление при запуске

```
App (isAuthenticated) → store.loadActiveTimeEntry()
  → api.getActiveTimeEntries()
  → [если пусто] clearTrackingStateFromServer или return (если Timer Engine RUNNING/PAUSED)
  → [если есть] синхронизация engine с сервером (start/resume/pause)
  → set(currentTimeEntry, selectedProject, isTracking, isPaused)
```

**При изменении:** при офлайне loadActiveTimeEntry падает — не трогать store; loadProjects при ошибке не очищает projects.

---

### 2.7 Синхронизация (периодическая)

```
App (каждые 30 с, задержка 30 с после старта)
  → api.getActiveTimeEntries() + get_timer_state
  → если сервер RUNNING, локально не RUNNING → resumeTracking(_, true)
  → если сервер PAUSED/STOPPED, локально RUNNING → pause/stop
```

**При изменении:** не гасить только что восстановленный таймер; не синкать при idlePauseStartTime (пользователь решает в idle-окне).

---

### 2.8 Закрытие / сон

```
Закрытие: tauri://close-requested → engine.save_state()
Периодически: каждые 30 с → engine.save_state()
beforeunload: saveTimerState() [fallback, может не успеть]
Сон: get_state видит time gap → handle_system_sleep → pause + save
```

---

## 3. Инварианты (не нарушать)

| Инвариант | Где проверять |
|-----------|---------------|
| `isTracking` = (engine RUNNING или PAUSED) | Timer.tsx updateTimerState, checkIdleStatus |
| `isPaused` = (engine PAUSED) | То же |
| `idlePauseStartTime !== null` ⇒ не вызывать checkIdleStatus pause | checkIdleStatus |
| При RUNNING — `start_activity_monitoring` | Timer, resumeTracking, loadActiveTimeEntry |
| При STOPPED/PAUSED (не idle) — `stop_activity_monitoring` | pauseTracking, stopTracking |
| `currentTimeEntry` согласован с engine | loadActiveTimeEntry, startTracking, sync |

---

## 4. Матрица «меняю X → проверяю Y»

| Меняю | Обязательно проверить |
|-------|------------------------|
| `startTracking` | Офлайн (getActiveTimeEntries), mark_task_sent, start_activity_monitoring |
| `pauseTracking` | stop_activity_monitoring, hide_idle_window; при isIdlePause — pause_timer_idle(work_elapsed), не pause_timer |
| `resumeTracking` | start_activity_monitoring, hide_idle_window, idlePauseStartTime |
| `stopTracking` | hide_idle_window, stop_activity_monitoring |
| `checkIdleStatus` | idleThreshold ≥ 1, idlePauseStartTime skip, lastActivityTime источники |
| `loadActiveTimeEntry` | Офлайн (не ломать store), projects при пустом списке |
| `loadProjects` | При ошибке не очищать projects |
| `updateActivityTime` | Вызывается из activity-detected и DOM fallback |
| Rust `get_state` | Сон (time gap), rollover дня |
| Rust `start_activity_monitoring` | activity-detected emit при idle < 5s |
| Sync queue | mark_task_sent после HTTP success, retry при ошибке |

---

## 5. Файлы по ответственности

| Файл | Ответственность |
|------|-----------------|
| `src/store/useTrackerStore.ts` | Оркестрация: start/pause/resume/stop, loadActiveTimeEntry, checkIdleStatus, updateActivityTime |
| `src/App.tsx` | Listeners (activity-detected, resume/stop), checkIdleStatus interval, DOM fallback, sync interval |
| `src/components/Timer.tsx` | UI, getTimerState poll, handleStart/Pause/Resume/Stop |
| `src/components/IdleWindow.tsx` | Resume/Stop → invoke → события |
| `src-tauri/src/commands.rs` | start_activity_monitoring, show_idle_window, invoke handlers |
| `src-tauri/src/engine/` | FSM, save_state, sleep/wake, rollover |
| `src-tauri/src/sync/` | enqueue, sync_queue, mark_task_sent |

---

## 6. Перед коммитом

1. `pnpm test` — зелёные
2. Прогнать вручную: старт → пауза → возобновление → стоп
3. Прогнать: idle (подождать порог) → Resume / Stop
4. Прогнать: офлайн старт (если возможно)
5. Сверить с матрицей «меняю X → проверяю Y»
