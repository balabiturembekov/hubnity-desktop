# Согласованность логики приложения

Проверка соответствия логики фронта и бэкенда по основным сценариям.

---

## 1. Таймер: Start / Pause / Resume / Stop

| Действие | Порядок на фронте | Бэкенд | Соответствие |
|----------|-------------------|--------|--------------|
| **Start** | 1) enqueue_time_entry('start', payload) 2) api.startTimeEntry 3) getState → start() или resume() | engine.start() — Stopped→Running или Paused→Running; enqueue в sync | ✅ |
| **Pause** | 1) enqueue_time_entry('pause', { id }) 2) api.pauseTimeEntry 3) pause_timer | engine.pause() — Running→Paused; enqueue | ✅ |
| **Resume** | 1) enqueue_time_entry('resume', { id }) 2) api.resumeTimeEntry 3) resume_timer | engine.resume() — Paused→Running; enqueue | ✅ |
| **Stop** | 1) enqueue_time_entry('stop', { id }) 2) api.stopTimeEntry 3) stop_timer | engine.stop() — Running/Paused→Stopped; enqueue | ✅ |

**Итог:** Порядок везде одинаковый: очередь (offline-first) → API (для UI и id) → движок (source of truth по времени). Соответствует.

---

## 2. Source of truth

| Данные | Где хранится | Где отображается |
|--------|--------------|------------------|
| Время (elapsed, accumulated) | Rust Timer Engine + БД (save_state) | Timer.tsx через get_timer_state каждую секунду |
| Состояние FSM (RUNNING/PAUSED/STOPPED) | Rust engine | Store синхронизирует isTracking/isPaused из get_timer_state (Timer.tsx interval) |
| Текущая запись (time entry, проект) | API + store (currentTimeEntry) | UI из store |

**Итог:** Время и FSM — из движка; запись и проект — из API/store. Дублирования подсчёта времени на фронте нет. Соответствует.

---

## 3. Восстановление при загрузке (startTracking при наличии active entry)

| Ситуация | Действие фронта | Движок | Соответствие |
|----------|------------------|--------|--------------|
| API: одна запись RUNNING | start() если engine STOPPED, resume() если PAUSED, иначе ничего | start/resume только при допустимом переходе | ✅ |
| API: одна запись PAUSED | getState → если RUNNING то pause(), если STOPPED то start()+pause() | Синхронизация движка с записью на паузе | ✅ |

**Итог:** При открытии приложения движок приводится в соответствие с состоянием записи на сервере. Соответствует.

---

## 4. Auth и токены

| Событие | Фронт | Rust |
|---------|--------|------|
| Логин | useAuthStore.login → api.login → set_tokens(access, refresh) | set_auth_tokens → AuthManager.set_tokens |
| Загрузка приложения | restoreTokens → set_tokens из localStorage | AuthManager хранит токены |
| Refresh (API 401) | api interceptor → refresh → set_tokens | set_auth_tokens после refresh |
| Sync (401) | — | auth_manager.refresh_token(), повтор запроса |

**Итог:** Токены в Rust совпадают с фронтом (set_auth_tokens при логине и после refresh). Sync при 401 обновляет токен в AuthManager; фронт при следующем запросе может обновить свои токены через interceptor. Соответствует.

---

## 5. Idle

| Шаг | Фронт | Rust |
|-----|--------|------|
| Обнаружение idle | Показ idle-окна, вызов pauseTracking(isIdlePause: true) | pause_timer, enqueue pause |
| Кнопка «Продолжить» в idle-окне | invoke('resume_tracking_from_idle') | emit('resume-tracking') в main |
| Main окно | listen('resume-tracking') → resumeTracking() | — |
| Кнопка «Стоп» в idle-окне | invoke('stop_tracking_from_idle') | emit('stop-tracking') в main |
| Main окно | listen('stop-tracking') → stopTracking() | — |

**Итог:** Idle → пауза движка и очереди; возобновление/остановка через события в main и вызов resumeTracking/stopTracking. Соответствует.

---

## 6. Смена дня (reset day)

| Где | Поведение |
|-----|-----------|
| **Rust** | ensure_correct_day() при start/pause/stop/get_state — при смене дня rollover_day (время до полуночи в accumulated, переход в Stopped, обнуление дня). reset_day() — при RUNNING сначала stop(), затем accumulated=0, новый day_start. |
| **Фронт** | Timer.tsx раз в 60 с сравнивает day_start с текущим днём (UTC); при отличии вызывает resetDay() → reset_timer_day + get_state, обновляет локальный timerState. |

**Соответствие:** Оба механизма (ensure_correct_day в Rust и явный resetDay на фронте) сбрасывают день и накопленное время в движке. Поведение согласовано.

**Ограничение:** reset_day() в Rust только меняет состояние движка (и при RUNNING останавливает таймер). Запись на сервере (time entry) при этом не останавливается и не паузится. То есть при смене дня во время RUNNING: движок станет Stopped, accumulated=0, а на сервере запись может остаться RUNNING. Это осознанное разделение: «день» и accumulated — локальные; серверная запись живёт своей жизнью и синхронизируется отдельно (очередь, API). Если нужно полное совпадение «движок остановлен ↔ запись на сервере остановлена», при смене дня на фронте можно дополнительно вызывать stopTracking() (или отдельный API «завершить запись при смене дня») — сейчас этого нет.

---

## 7. Сохранение состояния при закрытии

| Где | Поведение |
|-----|-----------|
| **Rust** | Событие tauri://close-requested → engine.save_state() |
| **Фронт** | beforeunload → saveTimerState() (invoke save_timer_state) как доп. защита |

**Итог:** Состояние движка сохраняется и при закрытии из Rust, и при beforeunload на фронте. Соответствует.

---

## 8. Типы и контракты

| Элемент | Фронт | Rust | Соответствие |
|---------|--------|------|--------------|
| TimerStateResponse | state: 'STOPPED' \| 'RUNNING' \| 'PAUSED', elapsed_seconds, accumulated_seconds, session_start, day_start | TimerStateForAPI + elapsed_seconds, ... ; #[serde(flatten)] | ✅ |
| resetDay возврат | store.resetDay() → Promise<TimerStateResponse> (getState после reset) | reset_timer_day → (); get_timer_state возвращает состояние | ✅ Timer.tsx использует возвращённое состояние |

**Итог:** Типы и использование возвращаемых значений совпадают.

---

## 9. Возможные расхождения (не баги)

1. **Смена дня при RUNNING:** движок переводится в Stopped и обнуляет день; запись на сервере не завершается автоматически (см. п. 6).
2. **Ошибка API при start/pause/stop:** запись в очередь уже есть; движок уже переведён; при следующей синхронизации операция уйдёт на сервер. Состояние UI и движка после ошибки API остаётся согласованным с очередью и движком.

---

## Итог

- Логика **таймера** (start/pause/resume/stop), **очереди**, **движка** и **UI** согласована: один порядок операций, один source of truth по времени (Rust), синхронизация состояния из get_timer_state.
- **Auth** и **sync** с refresh при 401 соответствуют ожидаемой схеме; токены в Rust и на фронте синхронизируются через set_auth_tokens.
- **Idle** и **resume/stop from idle** реализованы через события и вызовы store — соответствуют.
- **Смена дня** в движке и на фронте согласована; явное ограничение — серверная запись при смене дня не завершается автоматически (при необходимости это можно добавить отдельным сценарием).

В целом логика приложения **соответствует** заложенной модели; расхождений, которые ломают сценарии, не найдено.
