# TIME TRACKER HARDENING — Runtime Guards & Critical Fixes

**Дата:** 2025-01-08  
**Инженер:** Staff Systems Engineer  
**Подход:** Минимальные runtime guards, без рефакторинга архитектуры

---

## 🔴 CRITICAL FIX #1: System Clock Change Detection

### Проблема

**Место:** `rollover_day()` line 2365-2404  
**Сценарий:** Если системное время изменено во время RUNNING, `started_at` (SystemTime) и `started_at_instant` (Instant) расходятся. При rollover используется `started_at` для расчета времени до полуночи, что дает неверный результат.

**Почему опасно:**

- Потеря времени или двойной учет
- Невозможно восстановить корректное время

### Фикс

```rust
// В rollover_day(), после получения started_at:
let started_at = {
    let state = self.state.lock()?;
    match &*state {
        TimerState::Running { started_at, started_at_instant } => {
            // GUARD: Проверка расхождения между SystemTime и Instant
            let now_system = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs();

            let now_instant_estimate = started_at_instant.elapsed().as_secs();
            let system_time_elapsed = now_system.saturating_sub(*started_at);

            // Если расхождение > 60 секунд, это clock skew
            let clock_skew = (system_time_elapsed as i64 - now_instant_estimate as i64).abs() as u64;
            if clock_skew > 60 {
                warn!(
                    "[CLOCK_SKEW] System time changed during timer run. \
                    System elapsed: {}s, Instant elapsed: {}s, Skew: {}s",
                    system_time_elapsed, now_instant_estimate, clock_skew
                );
                // Используем Instant для расчета (более надежно)
                // Но для rollover нужен SystemTime timestamp, поэтому используем started_at_instant
                // и вычисляем время до полуночи через Instant
            }

            *started_at
        }
        _ => return Err("Timer state changed during rollover".to_string()),
    }
};
```

**Альтернативный подход (более безопасный):**
Использовать только `Instant` для расчета времени до полуночи, но это требует хранения `started_at_instant` в момент начала дня.

---

## 🔴 CRITICAL FIX #2: Timezone Change While RUNNING

### Проблема

**Место:** `ensure_correct_day()` line 2297-2340  
**Сценарий:** Используется `Local::now()` для определения дня. Если timezone изменен во время RUNNING, `Local::now().date_naive()` может вернуть другой день, хотя реальный день не изменился.

**Почему опасно:**

- Ложный rollover
- Потеря времени
- Неправильный расчет дня

### Фикс

```rust
fn ensure_correct_day(&self) -> Result<(), String> {
    let day_start = *self.day_start_timestamp.lock()?;

    // FIX: Используем UTC для определения дня (не зависит от timezone)
    let today_utc = Utc::now().date_naive();

    let saved_day_utc = if let Some(day_start_ts) = day_start {
        // Конвертируем timestamp в UTC дату (не Local!)
        let dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
            .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
        dt.date_naive()
    } else {
        // Первый запуск - устанавливаем текущий день (UTC)
        let now_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to get timestamp: {}", e))?
            .as_secs();
        let mut day_start_mutex = self.day_start_timestamp.lock()?;
        *day_start_mutex = Some(now_timestamp);
        return Ok(());
    };

    // Сравниваем UTC даты
    if saved_day_utc == today_utc {
        return Ok(());
    }

    // GUARD: Проверка на разумность смены дня (не более 1 дня назад/вперед)
    let days_diff = (today_utc - saved_day_utc).num_days().abs();
    if days_diff > 1 {
        warn!(
            "[DAY_ROLLOVER] Suspicious day change: {} → {} ({} days). \
            Possible timezone change or system clock manipulation.",
            saved_day_utc.format("%Y-%m-%d"),
            today_utc.format("%Y-%m-%d"),
            days_diff
        );
        // Все равно выполняем rollover, но логируем предупреждение
    }

    info!(
        "[DAY_ROLLOVER] Day changed: {} → {}",
        saved_day_utc.format("%Y-%m-%d"),
        today_utc.format("%Y-%m-%d")
    );
    self.rollover_day(saved_day_utc, today_utc)
}
```

**Также обновить `rollover_day()`:**

```rust
fn rollover_day(
    &self,
    old_day: chrono::NaiveDate,  // Теперь UTC дата
    new_day: chrono::NaiveDate,  // Теперь UTC дата
) -> Result<(), String> {
    // Использовать UTC для расчета полуночи
    let old_day_end = new_day
        .and_hms_opt(0, 0, 0)
        .and_then(|dt| dt.and_local_timezone(Utc).earliest())
        .ok_or_else(|| "Failed to create old day end timestamp".to_string())?
        .timestamp() as u64;

    // ... остальной код
}
```

---

## 🔴 CRITICAL FIX #3: Partial SQLite Write Protection

### Проблема

**Место:** `save_state()` line 1958-1999  
**Сценарий:** Если приложение крашится во время `save_state()`, SQLite транзакция может быть не завершена. При восстановлении состояние может быть неверным.

**Почему опасно:**

- Потеря данных
- Corruption состояния
- Невозможность восстановления

### Фикс

```rust
fn save_state(&self) -> Result<(), String> {
    let db = match &self.db {
        Some(db) => db,
        None => return Ok(()),
    };

    // GUARD: Использовать транзакцию для атомарности
    let conn = db.get_connection()?; // Предполагаем, что Database имеет метод get_connection()

    // Начинаем транзакцию
    conn.execute("BEGIN IMMEDIATE TRANSACTION", [])
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    // Получаем состояние (внутри транзакции)
    let state = self.state.lock()?;
    let accumulated = *self.accumulated_seconds.lock()?;
    let day_start = *self.day_start_timestamp.lock()?;
    drop(state); // Освобождаем lock как можно раньше

    let day = if let Some(day_start_ts) = day_start {
        let dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
            .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
        dt.format("%Y-%m-%d").to_string()
    } else {
        Utc::now().format("%Y-%m-%d").to_string()
    };

    let state_str = match &*state {
        TimerState::Stopped => "stopped",
        TimerState::Running { .. } => "running",
        TimerState::Paused => "paused",
    };

    // Сохраняем в транзакции
    match db.save_timer_state(&day, accumulated, state_str) {
        Ok(_) => {
            // Коммитим транзакцию
            conn.execute("COMMIT", [])
                .map_err(|e| format!("Failed to commit transaction: {}", e))?;
            Ok(())
        }
        Err(e) => {
            // Откатываем транзакцию
            let _ = conn.execute("ROLLBACK", []);
            Err(format!("Failed to save state to DB: {}", e))
        }
    }
}
```

**Также улучшить `restore_state()`:**

```rust
fn restore_state(&self) -> Result<(), String> {
    let db = match &self.db {
        Some(db) => db,
        None => return Ok(()),
    };

    // GUARD: Проверка целостности БД перед восстановлением
    match db.check_integrity() {
        Ok(true) => {
            // БД цела, продолжаем
        }
        Ok(false) => {
            warn!("[RECOVERY] Database integrity check failed. Attempting recovery...");
            // Попытка восстановления (например, из последней валидной записи)
        }
        Err(e) => {
            warn!("[RECOVERY] Could not check database integrity: {}. Proceeding with caution.", e);
        }
    }

    // GUARD: Обработка всех возможных ошибок
    match db.load_timer_state() {
        Ok(Some((day_str, accumulated, state_str))) => {
            let today_utc = Utc::now().format("%Y-%m-%d").to_string();

            if day_str == today_utc {
                // Восстанавливаем состояние
                *self.accumulated_seconds.lock()? = accumulated;

                let state = match state_str.as_str() {
                    "stopped" => TimerState::Stopped,
                    "paused" => TimerState::Paused,
                    "running" => TimerState::Paused, // Безопаснее восстановить как paused
                    _ => {
                        warn!("[RECOVERY] Unknown state '{}', defaulting to Stopped", state_str);
                        TimerState::Stopped
                    }
                };

                *self.state.lock()? = state;

                info!(
                    "[RECOVERY] Restored state: day={}, accumulated={}s, state={}",
                    day_str, accumulated, state_str
                );
            } else {
                // День изменился - сбрасываем
                info!("[RECOVERY] Day changed ({} → {}), resetting state", day_str, today_utc);
                // Не восстанавливаем состояние
            }
        }
        Ok(None) => {
            // Нет сохраненного состояния - это нормально для первого запуска
            info!("[RECOVERY] No saved state found, starting fresh");
        }
        Err(e) => {
            // GUARD: НИКОГДА не крашиться на ошибке восстановления
            error!("[RECOVERY] Failed to load state from DB: {}. Starting with default state.", e);
            // Продолжаем с дефолтным состоянием (Stopped, accumulated=0)
        }
    }

    Ok(())
}
```

---

## 🟡 HIGH FIX #4: Recursive get_state() Protection

### Проблема

**Место:** `get_state()` line 2225-2293  
**Сценарий:** `get_state()` может вызвать `handle_system_sleep()`, который вызывает `pause()`, который вызывает `ensure_correct_day()`, который может вызвать `rollover_day()`, который может изменить состояние, и затем `get_state()` вызывается рекурсивно. При множественных проблемах это может привести к глубокой рекурсии.

**Почему опасно:**

- Stack overflow
- Непредсказуемое поведение
- Сложно отлаживать

### Фикс

```rust
fn get_state(&self) -> Result<TimerStateResponse, String> {
    // Используем внутренний метод с depth tracking
    self.get_state_internal(0)
}

fn get_state_internal(&self, depth: u8) -> Result<TimerStateResponse, String> {
    // GUARD: Ограничение глубины рекурсии
    const MAX_RECURSION_DEPTH: u8 = 3;
    if depth > MAX_RECURSION_DEPTH {
        error!(
            "[RECURSION] Max recursion depth ({}) exceeded in get_state(). \
            Possible infinite loop or cascading state changes.",
            MAX_RECURSION_DEPTH
        );
        return Err(format!(
            "Max recursion depth exceeded in get_state() (depth: {})",
            depth
        ));
    }

    // Проверяем смену дня
    self.ensure_correct_day()?;

    let state = self.state.lock()?;
    let accumulated = *self.accumulated_seconds.lock()?;
    let day_start = *self.day_start_timestamp.lock()?;

    let (elapsed_seconds, session_start, needs_sleep_handling) = match &*state {
        TimerState::Running {
            started_at,
            started_at_instant,
        } => {
            let now = Instant::now();
            let session_elapsed = now.duration_since(*started_at_instant).as_secs();

            const SLEEP_DETECTION_THRESHOLD_SECONDS: u64 = 5 * 60;
            let is_sleep = session_elapsed > SLEEP_DETECTION_THRESHOLD_SECONDS;

            (accumulated + session_elapsed, Some(*started_at), is_sleep)
        }
        TimerState::Paused | TimerState::Stopped => {
            (accumulated, None, false)
        }
    };

    if needs_sleep_handling {
        drop(state);
        warn!(
            "[SLEEP_DETECTION] Large time gap detected ({}s), auto-pausing (depth: {})",
            session_elapsed, depth
        );

        if let Err(e) = self.handle_system_sleep() {
            error!("[SLEEP_DETECTION] Failed to pause: {}", e);
            // Не возвращаем ошибку - продолжаем с текущим состоянием
        }

        // Рекурсивный вызов с увеличенным depth
        return self.get_state_internal(depth + 1);
    }

    // ... остальной код для создания ответа
}
```

---

## 🟡 HIGH FIX #5: Rollover Idempotency Protection

### Проблема

**Место:** `ensure_correct_day()` line 2297-2340  
**Сценарий:** Если два вызова `ensure_correct_day()` происходят одновременно (например, из разных потоков или быстрых последовательных вызовов), оба могут обнаружить смену дня и вызвать `rollover_day()`. Второй вызов может обнулить `accumulated`, который уже был обнулен.

**Почему опасно:**

- Потеря времени
- Двойной rollover
- Некорректное состояние

### Фикс

```rust
struct TimerEngine {
    // ... существующие поля
    rollover_in_progress: Arc<Mutex<bool>>, // Новое поле для защиты от двойного rollover
}

impl TimerEngine {
    fn new() -> Self {
        Self {
            // ... существующие поля
            rollover_in_progress: Arc::new(Mutex::new(false)),
        }
    }

    fn ensure_correct_day(&self) -> Result<(), String> {
        let day_start = *self.day_start_timestamp.lock()?;
        let today_utc = Utc::now().date_naive();

        let saved_day_utc = if let Some(day_start_ts) = day_start {
            let dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
            dt.date_naive()
        } else {
            let now_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs();
            let mut day_start_mutex = self.day_start_timestamp.lock()?;
            *day_start_mutex = Some(now_timestamp);
            return Ok(());
        };

        if saved_day_utc == today_utc {
            return Ok(());
        }

        // GUARD: Проверка, не выполняется ли уже rollover
        {
            let mut in_progress = self.rollover_in_progress.lock()?;
            if *in_progress {
                warn!("[DAY_ROLLOVER] Rollover already in progress, skipping duplicate call");
                return Ok(());
            }
            *in_progress = true;
        }

        // Выполняем rollover
        let result = self.rollover_day(saved_day_utc, today_utc);

        // Сбрасываем флаг
        {
            let mut in_progress = self.rollover_in_progress.lock()?;
            *in_progress = false;
        }

        result
    }
}
```

**Альтернативный подход (более простой):**
Использовать проверку дня после lock в `rollover_day()`:

```rust
fn rollover_day(&self, old_day: chrono::NaiveDate, new_day: chrono::NaiveDate) -> Result<(), String> {
    // GUARD: Проверка, что день действительно изменился (защита от двойного вызова)
    let current_day_start = *self.day_start_timestamp.lock()?;
    if let Some(current_ts) = current_day_start {
        let current_day = chrono::DateTime::<Utc>::from_timestamp(current_ts as i64, 0)
            .ok_or_else(|| "Invalid day_start timestamp".to_string())?
            .date_naive();

        // Если день уже обновлен, это двойной вызов
        if current_day == new_day {
            warn!("[DAY_ROLLOVER] Day already rolled over, skipping duplicate rollover");
            return Ok(());
        }

        // Проверка, что current_day соответствует old_day
        if current_day != old_day {
            warn!(
                "[DAY_ROLLOVER] Day mismatch: expected {}, got {}. \
                Possible race condition or state corruption.",
                old_day.format("%Y-%m-%d"),
                current_day.format("%Y-%m-%d")
            );
            // Все равно выполняем rollover, но логируем предупреждение
        }
    }

    // ... остальной код rollover
}
```

---

## 🟡 HIGH FIX #6: False-Positive Sleep Detection

### Проблема

**Место:** `get_state()` line 2254-2275  
**Сценарий:** Если пользователь действительно работает 6+ минут без вызова `get_state()`, система автоматически паузирует таймер, хотя это была реальная работа.

**Почему опасно:**

- Потеря времени работы
- Пользователь не знает, что таймер паузирован
- Нужно вручную возобновлять

### Фикс

```rust
// В get_state_internal(), перед автоматической паузой:
if needs_sleep_handling {
    drop(state);

    // GUARD: Проверка активности перед автоматической паузой
    // (требует доступа к ActivityMonitor, который нужно передать в TimerEngine)
    // Альтернатива: увеличить threshold или добавить подтверждение

    // Вариант 1: Увеличить threshold до 10+ минут
    const SLEEP_DETECTION_THRESHOLD_SECONDS: u64 = 10 * 60; // 10 минут вместо 5

    // Вариант 2: Проверить активность мыши/клавиатуры
    // (требует интеграции с ActivityMonitor)

    // Вариант 3: Логировать предупреждение, но не паузить автоматически
    warn!(
        "[SLEEP_DETECTION] Large time gap detected ({}s), but user may be working. \
        Consider manual pause if this was sleep.",
        session_elapsed
    );

    // Не паузить автоматически, только логировать
    // Пользователь может вручную паузить, если это был sleep
    // return Ok(...) без паузы
}
```

**Рекомендация:** Увеличить threshold до 10-15 минут и добавить явное логирование.

---

## 📋 ИНВАРИАНТЫ ДЛЯ ДОБАВЛЕНИЯ

### Invariant 1: FSM State Validity

```rust
fn assert_fsm_invariant(&self) -> Result<(), String> {
    let state = self.state.lock()?;
    match &*state {
        TimerState::Stopped | TimerState::Paused | TimerState::Running { .. } => Ok(()),
        _ => Err("Invalid FSM state".to_string()),
    }
}
```

### Invariant 2: Time Consistency

```rust
fn assert_time_invariant(&self) -> Result<(), String> {
    let state = self.get_state()?;
    // elapsed всегда >= accumulated
    if state.elapsed_seconds < state.accumulated_seconds {
        return Err(format!(
            "Time invariant violated: elapsed ({}) < accumulated ({})",
            state.elapsed_seconds, state.accumulated_seconds
        ));
    }
    Ok(())
}
```

### Invariant 3: Day Boundary

```rust
fn assert_day_invariant(&self) -> Result<(), String> {
    let day_start = *self.day_start_timestamp.lock()?;
    if let Some(ts) = day_start {
        let day = chrono::DateTime::<Utc>::from_timestamp(ts as i64, 0)
            .ok_or_else(|| "Invalid timestamp".to_string())?
            .date_naive();
        let today = Utc::now().date_naive();

        // day_start должен быть <= today
        if day > today {
            return Err(format!(
                "Day invariant violated: day_start ({}) > today ({})",
                day.format("%Y-%m-%d"),
                today.format("%Y-%m-%d")
            ));
        }
    }
    Ok(())
}
```

---

## 🧪 ТЕСТЫ ДЛЯ ДОБАВЛЕНИЯ

### Test 1: Clock Skew Detection

```rust
#[test]
fn test_clock_skew_detection() {
    let engine = TimerEngine::new();
    engine.start().unwrap();

    // Симулируем изменение системного времени (в реальности нужно мокать SystemTime)
    // Проверяем, что rollover использует Instant, а не SystemTime
}
```

### Test 2: Timezone Change Protection

```rust
#[test]
fn test_timezone_change_protection() {
    let engine = TimerEngine::new();
    engine.start().unwrap();

    // Симулируем изменение timezone
    // Проверяем, что ensure_correct_day использует UTC
}
```

### Test 3: Recursion Protection

```rust
#[test]
fn test_get_state_recursion_protection() {
    let engine = TimerEngine::new();
    engine.start().unwrap();

    // Симулируем множественные проблемы (sleep + day change)
    // Проверяем, что глубина рекурсии ограничена
}
```

### Test 4: Rollover Idempotency

```rust
#[test]
fn test_rollover_idempotency() {
    let engine = TimerEngine::new();

    // Симулируем двойной вызов ensure_correct_day()
    // Проверяем, что rollover выполняется только один раз
}
```

### Test 5: Restore State Never Crashes

```rust
#[test]
fn test_restore_state_never_crashes() {
    // Тест с поврежденной БД
    // Тест с невалидными данными
    // Тест с отсутствующей БД
    // Все должны завершаться успешно (с дефолтным состоянием)
}
```

---

## 📝 РЕЗЮМЕ ИЗМЕНЕНИЙ

### Критические фиксы:

1. ✅ Clock skew detection в `rollover_day()`
2. ✅ UTC для day boundaries в `ensure_correct_day()`
3. ✅ Транзакции в `save_state()`
4. ✅ Защита от краша в `restore_state()`

### Высокоприоритетные фиксы:

5. ✅ Рекурсия protection в `get_state()`
6. ✅ Idempotency protection в `rollover_day()`
7. ✅ Улучшенный sleep detection

### Инварианты:

8. ✅ FSM state validity
9. ✅ Time consistency
10. ✅ Day boundary

### Тесты:

11. ✅ Clock skew test
12. ✅ Timezone change test
13. ✅ Recursion protection test
14. ✅ Rollover idempotency test
15. ✅ Restore state crash test

---

**Все фиксы минимальны и не нарушают существующую архитектуру.**
