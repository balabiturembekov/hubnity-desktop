# ЭТАП 2 — STRICT STATE MACHINE ✅

## 📋 ОТЧЕТ О ВЫПОЛНЕНИИ

### 1. Как выглядит FSM (словами)

**Состояния:**
- `Stopped` — таймер остановлен
- `Running { started_at: u64, started_at_instant: Instant }` — таймер работает, хранит время начала сессии
- `Paused` — таймер на паузе

**Допустимые переходы:**
```
Stopped → start() → Running
Running → pause() → Paused
Paused → resume() → Running
Running → stop() → Stopped
Paused → stop() → Stopped
```

**Недопустимые переходы:**
- `Running → Running` — ошибка: "Timer is already running"
- `Paused → Paused` — ошибка: "Timer is already paused"
- `Stopped → Paused` — ошибка: "Cannot pause stopped timer"
- `Stopped → Running` через `resume()` — ошибка: "Cannot resume stopped timer. Use start() instead"
- `Stopped → Stopped` — ошибка: "Timer is already stopped"

**Логика времени:**
- `accumulated_seconds` — хранится вне state, обновляется только при `pause()` и `stop()`
- `elapsed()` — если `Running` → `accumulated + (now - started_at_instant)`, иначе → `accumulated`

---

### 2. Какие структуры изменены

#### ✅ `TimerState` enum → FSM enum
**Было:**
```rust
pub enum TimerState {
    Stopped,
    Running,
    Paused,
}
```

**Стало:**
```rust
pub enum TimerState {
    Stopped,
    Running {
        started_at: u64,              // Unix timestamp для API
        started_at_instant: Instant,  // Монотонное время для расчетов
    },
    Paused,
}
```

**Результат:** `started_at_instant` хранится внутри состояния, невозможно иметь `Running` без времени начала.

#### ✅ `TimerEngine` struct — упрощена
**Было:**
```rust
struct TimerEngine {
    state: Arc<Mutex<TimerState>>,
    session_start_instant: Arc<Mutex<Option<Instant>>>,  // УДАЛЕНО
    session_start_timestamp: Arc<Mutex<Option<u64>>>,    // УДАЛЕНО
    accumulated_seconds: Arc<Mutex<u64>>,
    last_known_instant: Arc<Mutex<Instant>>,              // УДАЛЕНО
    day_start_timestamp: Arc<Mutex<Option<u64>>>,
}
```

**Стало:**
```rust
struct TimerEngine {
    state: Arc<Mutex<TimerState>>,      // Единственный источник истины
    accumulated_seconds: Arc<Mutex<u64>>,
    day_start_timestamp: Arc<Mutex<Option<u64>>>,
}
```

**Результат:** Удалены 3 поля, данные хранятся внутри `TimerState::Running`.

#### ✅ `TimerStateForAPI` — новый тип для сериализации
```rust
pub enum TimerStateForAPI {
    Stopped,
    Running { started_at: u64 },
    Paused,
}
```

**Результат:** Отдельный тип для API без `Instant` (который не сериализуется).

---

### 3. Ключевые участки кода

#### Переход Stopped → Running:
```rust
fn start(&self) -> Result<(), String> {
    let mut state = self.state.lock()?;
    
    match &*state {
        TimerState::Stopped => {
            let now_instant = Instant::now();
            let now_timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            
            // Переход в Running с данными внутри
            *state = TimerState::Running {
                started_at: now_timestamp,
                started_at_instant: now_instant,
            };
            Ok(())
        }
        TimerState::Running { .. } => {
            eprintln!("[FSM ERROR] Invalid transition: Running → Running");
            Err("Timer is already running".to_string())
        }
        // ...
    }
}
```

#### Переход Running → Paused:
```rust
fn pause(&self) -> Result<(), String> {
    let mut state = self.state.lock()?;
    
    match &*state {
        TimerState::Running { started_at_instant, .. } => {
            let now = Instant::now();
            let session_elapsed = now.duration_since(*started_at_instant).as_secs();
            
            // Обновляем accumulated (единственное место обновления)
            let mut accumulated = self.accumulated_seconds.lock()?;
            *accumulated += session_elapsed;
            
            // Переход в Paused (started_at_instant удаляется из state)
            *state = TimerState::Paused;
            Ok(())
        }
        TimerState::Paused => {
            eprintln!("[FSM ERROR] Invalid transition: Paused → Paused");
            Err("Timer is already paused".to_string())
        }
        // ...
    }
}
```

#### Расчет elapsed:
```rust
fn get_state(&self) -> Result<TimerStateResponse, String> {
    let state = self.state.lock()?;
    let accumulated = *self.accumulated_seconds.lock()?;
    
    let (elapsed_seconds, session_start) = match &*state {
        TimerState::Running { started_at, started_at_instant } => {
            let now = Instant::now();
            let session_elapsed = now.duration_since(*started_at_instant).as_secs();
            (accumulated + session_elapsed, Some(*started_at))
        }
        TimerState::Paused | TimerState::Stopped => {
            (accumulated, None)
        }
    };
    // ...
}
```

---

### 4. Какие классы/поля удалены

#### Удалены поля из `TimerEngine`:
- ❌ `session_start_instant: Arc<Mutex<Option<Instant>>>` — теперь внутри `TimerState::Running`
- ❌ `session_start_timestamp: Arc<Mutex<Option<u64>>>` — теперь внутри `TimerState::Running`
- ❌ `last_known_instant: Arc<Mutex<Instant>>` — не нужен, используется `Instant::now()`

#### Удалены проверки:
- ❌ `if is_running && !is_paused` — невозможно, состояние определяется через enum
- ❌ `if session_start_instant.is_some()` — невозможно, `Running` всегда содержит `started_at_instant`
- ❌ Логика восстановления `session_start_instant` из отдельных полей

#### Упрощена логика:
- ❌ Множественные `Mutex` locks — теперь один lock на весь переход
- ❌ Проверки `Option<Instant>` — `Running` всегда содержит `Instant`
- ❌ Синхронизация между `session_start_instant` и `session_start_timestamp` — данные в одном месте

---

## ✅ РЕЗУЛЬТАТ

### Невозможные состояния отсутствуют
- Невозможно иметь `Running` без `started_at_instant` — компилятор не позволит
- Невозможно иметь `Paused` с активной сессией — `started_at_instant` удаляется при паузе
- Невозможно иметь несинхронизированные данные — все в одном месте

### Переходы формализованы
- Каждый переход проверяется через `match`
- Недопустимые переходы логируются через `eprintln!`
- Ошибки возвращаются явно, без silent-ignore

### Таймер нельзя сломать вызовами в неправильном порядке
- `start()` из `Running` → ошибка
- `pause()` из `Stopped` → ошибка
- `resume()` из `Stopped` → ошибка
- Все ошибки логируются и возвращаются

### Код стал ПРОЩЕ, а не сложнее
- Удалено 3 поля из структуры
- Удалены множественные проверки `Option`
- Один `Mutex` lock на весь переход (атомарность)
- Данные хранятся там, где используются (внутри enum)

---

## 📊 СТАТИСТИКА

- **Удалено полей:** 3 (`session_start_instant`, `session_start_timestamp`, `last_known_instant`)
- **Удалено проверок:** ~10+ (`if is_running`, `if session_start.is_some()`, etc.)
- **Упрощено методов:** 4 (`start`, `pause`, `resume`, `stop`)
- **Добавлено логирования:** 5 мест (недопустимые переходы)
- **Атомарность:** Все переходы атомарны (один mutex lock)

---

## ✅ ЭТАП 2 ЗАВЕРШЕН

**Timer Engine теперь строгая FSM:**
- ✅ Невозможные состояния физически невозможны
- ✅ Переходы формализованы и проверяются
- ✅ Ошибки логируются и возвращаются
- ✅ Код стал проще и понятнее

**Следующий шаг:** ЭТАП 3 — SQLITE + OFFLINE QUEUE
