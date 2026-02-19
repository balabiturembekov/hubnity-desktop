use crate::engine::TimerEngine;
use crate::engine::TimerState;
use crate::engine::{TimerStateForAPI, TimerStateResponse};
use chrono::{Local, Utc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

#[cfg(target_os = "windows")]
fn get_tick64_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}

impl TimerEngine {
    /// Порог для sleep detection (минуты) — из app_meta или default 5
    fn get_sleep_gap_threshold_seconds(&self) -> u64 {
        if let Some(ref db) = self.db {
            if let Ok(Some(val)) = db.get_app_meta("sleep_gap_threshold_minutes") {
                if let Ok(m) = val.parse::<u64>() {
                    return m.saturating_mul(60).max(60); // min 1 minute
                }
            }
        }
        5 * 60 // default 5 minutes
    }

    /// Returns true if sleep was detected < 30s ago (grace period to suppress false "active" from get_idle_time reset).
    pub fn is_just_awoken(&self) -> bool {
        const GRACE_SECS: u64 = 30;
        if let Ok(guard) = self.last_sleep_detected_at.lock() {
            if let Some(at) = *guard {
                return at.elapsed().as_secs() < GRACE_SECS;
            }
        }
        false
    }

    /// Обработка системного sleep (вызывается при обнаружении большого пропуска времени в get_state)
    /// Если RUNNING → pause и сохранить состояние
    fn handle_system_sleep(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running { .. } => {
                // Допустимый переход: Running → Paused (из-за sleep)
                drop(state); // Освобождаем lock перед вызовом pause()

                info!("[SLEEP] System sleep detected, pausing timer");

                // Устанавливаем reason для фронта (shouldSkipStalePaused не должен скипать sleep)
                if let Ok(mut r) = self.last_transition_reason.lock() {
                    *r = Some("sleep".to_string());
                }

                // Используем существующий метод pause() для корректного перехода FSM
                self.pause()?;

                info!("[SLEEP] Timer paused successfully due to system sleep");
                Ok(())
            }
            TimerState::Paused | TimerState::Stopped => {
                // Уже на паузе или остановлен - ничего не делаем (идемпотентно)
                info!("[SLEEP] System sleep detected, but timer is already paused/stopped");
                Ok(())
            }
        }
    }

    /// Обработка системного wake (вызывается из setup_sleep_wake_handlers при старте приложения)
    /// НЕ возобновляем автоматически - оставляем PAUSED
    pub fn handle_system_wake(&self) -> Result<(), String> {
        info!("[WAKE] System wake detected");

        // Проверяем текущее состояние
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let state_str = match &*state {
            TimerState::Running { .. } => "running",
            TimerState::Paused => "paused",
            TimerState::Stopped => "stopped",
        };
        drop(state);

        // Обновляем last_updated_at в БД
        // НЕ возобновляем RUNNING автоматически - безопаснее оставить PAUSED
        if let Err(e) = self.save_state() {
            error!("[WAKE] Failed to save state after wake: {}", e);
        }

        info!(
            "[WAKE] Timer state after wake: {} (user can resume manually)",
            state_str
        );
        Ok(())
    }

    /// Переход: Stopped → Running или Paused → Running
    /// Атомарная операция - один mutex lock на весь переход
    pub fn start(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Stopped => {
                // Допустимый переход: Stopped → Running
                let now_instant = Instant::now();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_millis() as u64;
                let now_secs = now_ms / 1000;

                // Если это первый старт за день, фиксируем начало дня
                let mut day_start = self
                    .day_start_timestamp
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                if day_start.is_none() {
                    *day_start = Some(now_secs);
                }
                drop(day_start); // Освобождаем lock

                // Переход в Running с данными внутри (milliseconds для точной синхронизации)
                *state = TimerState::Running {
                    started_at_ms: now_ms,
                    started_at_instant: now_instant,
                    #[cfg(target_os = "windows")]
                    started_at_tick64_ms: get_tick64_ms(),
                };
                drop(state); // Освобождаем lock перед сохранением

                // Сохраняем состояние в БД
                if let Err(e) = self.save_state() {
                    error!("[TIMER] Failed to save state after start: {}", e);
                    return Err(format!("Failed to save state after start: {}", e));
                }
                // Сбрасываем флаг восстановления после wake
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }

                Ok(())
            }
            TimerState::Paused => {
                // Допустимый переход: Paused → Running (resume через start)
                let now_instant = Instant::now();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_millis() as u64;

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at_ms: now_ms,
                    started_at_instant: now_instant,
                    #[cfg(target_os = "windows")]
                    started_at_tick64_ms: get_tick64_ms(),
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в других переходах start())
                if let Err(e) = self.save_state() {
                    error!(
                        "[TIMER] Failed to save state after start (Paused→Running): {}",
                        e
                    );
                    return Err(format!("Failed to save state after start: {}", e));
                }
                // Сбрасываем флаг восстановления после wake — пользователь явно возобновил
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }

                Ok(())
            }
            TimerState::Running { .. } => {
                // Недопустимый переход: Running → Running
                warn!("[FSM] Invalid transition: Running → Running (already running)");
                Err("Timer is already running".to_string())
            }
        }
    }

    /// Переход: Running → Paused
    /// Сохраняет время сессии в accumulated
    pub fn pause(&self) -> Result<(), String> {
        self.pause_internal(None)
    }

    /// Переход: Running → Paused при idle (исключаем время простоя)
    /// work_elapsed_secs — реальное время работы до lastActivityTime (без 2 мин простоя)
    pub fn pause_with_work_elapsed(&self, work_elapsed_secs: u64) -> Result<(), String> {
        if let Ok(mut r) = self.last_transition_reason.lock() {
            *r = Some("idle".to_string());
        }
        self.pause_internal(Some(work_elapsed_secs))
    }

    fn pause_internal(&self, work_elapsed_override: Option<u64>) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at_instant,
                #[cfg(target_os = "windows")]
                started_at_tick64_ms,
                ..
            } => {
                // Допустимый переход: Running → Paused
                // TIME MANIPULATION: Use ONLY monotonic clocks for accumulated increment.
                // Immune to NTP sync, manual clock changes. macOS: Instant. Windows: GetTickCount64 (sleep-aware).
                // SLEEP GAP: Instant/GetTick64 не тикают во сне — accumulated не включает время сна (Hubstaff-aligned).
                let now = Instant::now();
                let monotonic_elapsed = now.duration_since(*started_at_instant).as_secs();
                #[cfg(target_os = "windows")]
                let awake_elapsed = {
                    let tick64_now = get_tick64_ms();
                    tick64_now.saturating_sub(*started_at_tick64_ms) / 1000
                };
                #[cfg(target_os = "windows")]
                let base_elapsed = monotonic_elapsed.min(awake_elapsed); // GetTick64 doesn't tick during sleep
                #[cfg(not(target_os = "windows"))]
                let base_elapsed = monotonic_elapsed; // Instant doesn't tick during sleep on macOS
                let session_elapsed = match work_elapsed_override {
                    Some(work) => {
                        // Idle pause: используем только время до lastActivityTime
                        work.min(base_elapsed)
                    }
                    None => base_elapsed,
                };

                // CRITICAL FIX: Вычисляем новый accumulated БЕЗ обновления в памяти
                // Это позволяет сохранить атомарность: либо обновляем и сохраняем, либо ничего
                let new_accumulated = {
                    let accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    let old_value = *accumulated;
                    let new = accumulated.saturating_add(session_elapsed);
                    if old_value > new {
                        // Произошло насыщение (переполнение предотвращено)
                        warn!(
                            "[TIMER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                            old_value, session_elapsed, new
                        );
                    }
                    new
                };

                // CHAOS FIX: Save BEFORE mutating state — prevents inconsistent state on disk full
                drop(state); // Release lock before DB I/O
                if let Err(e) = self.save_pending_state(new_accumulated, "paused", None) {
                    error!("[TIMER] Failed to save state before pause: {}", e);
                    return Err(format!("Failed to save state: {}", e));
                }

                // Save succeeded — now mutate in-memory state
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    *state = TimerState::Paused;
                }
                {
                    let mut accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    *accumulated = new_accumulated;
                }

                Ok(())
            }
            TimerState::Paused => {
                // Недопустимый переход: Paused → Paused
                warn!("[FSM] Invalid transition: Paused → Paused (already paused)");
                Err("Timer is already paused".to_string())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Paused
                warn!("[FSM] Invalid transition: Stopped → Paused (cannot pause stopped timer)");
                Err("Cannot pause stopped timer".to_string())
            }
        }
    }

    /// Переход: Paused → Running
    /// Начинает новую сессию (accumulated сохраняется)
    pub fn resume(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Paused => {
                // Допустимый переход: Paused → Running
                let now_instant = Instant::now();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_millis() as u64;

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at_ms: now_ms,
                    started_at_instant: now_instant,
                    #[cfg(target_os = "windows")]
                    started_at_tick64_ms: get_tick64_ms(),
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в start(), pause(), stop())
                if let Err(e) = self.save_state() {
                    error!("[TIMER] Failed to save state after resume: {}", e);
                    return Err(format!("Failed to save state after resume: {}", e));
                }
                // Сбрасываем флаг восстановления после wake — пользователь явно возобновил
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }

                Ok(())
            }
            TimerState::Running { .. } => {
                // Недопустимый переход: Running → Running
                warn!("[FSM] Invalid transition: Running → Running (already running)");
                Err("Timer is already running".to_string())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Running (нужно использовать start)
                warn!("[FSM] Invalid transition: Stopped → Running (use start() instead)");
                Err("Cannot resume stopped timer. Use start() instead".to_string())
            }
        }
    }

    /// Переход: Running → Stopped или Paused → Stopped
    /// Сохраняет время сессии в accumulated (если Running)
    pub fn stop(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        self.stop_internal()
    }

    /// Внутренний метод остановки без проверки дня (для использования в rollover)
    fn stop_internal(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at_instant,
                #[cfg(target_os = "windows")]
                started_at_tick64_ms,
                ..
            } => {
                // Допустимый переход: Running → Stopped
                // TIME MANIPULATION: Use ONLY monotonic clocks for accumulated increment.
                let now = Instant::now();
                let monotonic_elapsed = now.duration_since(*started_at_instant).as_secs();
                #[cfg(target_os = "windows")]
                let session_elapsed = {
                    let tick64_now = get_tick64_ms();
                    let awake = tick64_now.saturating_sub(*started_at_tick64_ms) / 1000;
                    monotonic_elapsed.min(awake)
                };
                #[cfg(not(target_os = "windows"))]
                let session_elapsed = monotonic_elapsed;

                // CRITICAL FIX: Вычисляем новый accumulated БЕЗ обновления в памяти
                let new_accumulated = {
                    let accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    let old_value = *accumulated;
                    let new = accumulated.saturating_add(session_elapsed);
                    if old_value > new {
                        warn!(
                            "[TIMER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                            old_value, session_elapsed, new
                        );
                    }
                    new
                };

                // CHAOS FIX: Save BEFORE mutating (prevents inconsistent state on disk full)
                drop(state);
                if let Err(e) = self.save_pending_state(new_accumulated, "stopped", None) {
                    error!("[TIMER] Failed to save state before stop: {}", e);
                    return Err(format!("Failed to save state: {}", e));
                }
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    *state = TimerState::Stopped;
                }
                {
                    let mut accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    *accumulated = new_accumulated;
                }
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }
                Ok(())
            }
            TimerState::Paused => {
                let accumulated = *self
                    .accumulated_seconds
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                drop(state);
                if let Err(e) = self.save_pending_state(accumulated, "stopped", None) {
                    error!("[TIMER] Failed to save state before stop (Paused→Stopped): {}", e);
                    return Err(format!("Failed to save state: {}", e));
                }
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    *state = TimerState::Stopped;
                }
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }
                Ok(())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Stopped
                warn!("[FSM] Invalid transition: Stopped → Stopped (already stopped)");
                Err("Timer is already stopped".to_string())
            }
        }
    }

    /// Получить текущее состояние таймера
    /// ВАЖНО: Этот метод может мутировать состояние при обнаружении sleep
    /// Sleep detection: большие пропуски времени (> 5 мин) автоматически паузируют таймер
    pub fn get_state(&self) -> Result<TimerStateResponse, String> {
        // Используем внутренний метод с depth tracking для защиты от рекурсии
        self.get_state_internal(0)
    }

    /// Внутренний метод get_state с защитой от рекурсии
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

        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        // Проверяем состояние для sleep detection
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let accumulated = *self
            .accumulated_seconds
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        let now_wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Расчет elapsed только для RUNNING: Instant::now() - started_at (monotonic, u64 only).
        // Запрещено: f64 (накопление ошибки), инкремент вручную. Буфер 1150ms — избежать опережения.
        let (elapsed_seconds, session_start, session_start_ms, needs_sleep_handling) = match &*state
        {
            TimerState::Running {
                started_at_ms,
                started_at_instant,
                #[cfg(target_os = "windows")]
                started_at_tick64_ms,
                ..
            } => {
                let now = Instant::now();
                let wall_elapsed_secs = now_wall_ms.saturating_sub(*started_at_ms) / 1000;

                // Sleep detection: разрыв wall-clock vs «время без сна».
                // macOS: Instant не тикает во сне. Windows: GetTickCount64 не тикает во сне.
                let threshold_secs = self.get_sleep_gap_threshold_seconds();
                #[cfg(target_os = "windows")]
                let awake_elapsed_ms = {
                    let tick64_now = get_tick64_ms();
                    tick64_now.saturating_sub(*started_at_tick64_ms)
                };
                #[cfg(target_os = "windows")]
                let awake_elapsed_secs = awake_elapsed_ms / 1000;
                #[cfg(not(target_os = "windows"))]
                let awake_elapsed_secs = now.duration_since(*started_at_instant).as_secs();
                let is_sleep = wall_elapsed_secs > awake_elapsed_secs
                    && (wall_elapsed_secs - awake_elapsed_secs) >= threshold_secs;

                // displayed = awake_elapsed - 1150ms buffer (u64 only, no f64)
                #[cfg(target_os = "windows")]
                let displayed_ms = awake_elapsed_ms.saturating_sub(1150);
                #[cfg(not(target_os = "windows"))]
                let displayed_ms = now
                    .duration_since(*started_at_instant)
                    .as_millis()
                    .saturating_sub(1150);
                let displayed_elapsed = (displayed_ms / 1000) as u64;

                // Защита от переполнения
                let elapsed = accumulated.saturating_add(displayed_elapsed);
                (
                    elapsed,
                    Some(*started_at_ms / 1000),
                    Some(*started_at_ms),
                    is_sleep,
                )
            }
            TimerState::Paused | TimerState::Stopped => {
                // В PAUSED и STOPPED показываем только accumulated
                (accumulated, None, None, false)
            }
        };

        // Если обнаружен sleep (большой пропуск времени), вызываем handle_system_sleep для паузы
        if needs_sleep_handling {
            drop(state);
            if let Ok(mut t) = self.last_sleep_detected_at.lock() {
                *t = Some(Instant::now());
            }
            info!("[SLEEP_DETECTION] Sleep detected (gap or long session), pausing timer");
            if let Err(e) = self.handle_system_sleep() {
                warn!("[SLEEP_DETECTION] handle_system_sleep failed: {}", e);
            }
            return self.get_state_internal(depth + 1);
        }

        // Создаем упрощенную версию state для API (без Instant)
        let state_for_response = match &*state {
            TimerState::Stopped => TimerStateForAPI::Stopped,
            TimerState::Running { started_at_ms, .. } => TimerStateForAPI::Running {
                started_at: *started_at_ms / 1000,
            },
            TimerState::Paused => TimerStateForAPI::Paused,
        };

        // Этап 4: прочитать флаг «восстановлено из RUNNING»
        // НЕ сбрасываем здесь — сбрасываем только при resume/start (пользователь явно возобновил)
        // Это позволяет loadActiveTimeEntry не авто-возобновлять таймер после wake
        let restored_from_running = self
            .restored_from_running
            .lock()
            .map(|f| *f)
            .unwrap_or(false);

        // Читаем и очищаем reason (одноразовое для фронта)
        let reason = {
            if let Ok(mut r) = self.last_transition_reason.lock() {
                std::mem::take(&mut *r)
            } else {
                None
            }
        };

        // today_seconds: для "Today" display. При rollover — время с полуночи. today <= elapsed всегда.
        let today_seconds = match &*state {
            TimerState::Running { started_at_ms, .. } => {
                let rolled_over = day_start.map_or(false, |ds| *started_at_ms / 1000 == ds);
                if rolled_over {
                    let from_midnight = day_start
                        .map(|ds| {
                            let day_start_ms = ds * 1000;
                            let raw_ms = now_wall_ms.saturating_sub(day_start_ms);
                            let displayed_ms = raw_ms.saturating_sub(1150);
                            displayed_ms / 1000
                        })
                        .unwrap_or(accumulated);
                    from_midnight.min(elapsed_seconds)
                } else {
                    elapsed_seconds
                }
            }
            TimerState::Paused | TimerState::Stopped => accumulated,
        };

        Ok(TimerStateResponse {
            state: state_for_response,
            elapsed_seconds,
            accumulated_seconds: accumulated,
            session_start,
            session_start_ms,
            day_start,
            today_seconds,
            restored_from_running,
            reason,
        })
    }

    /// Проверить и обработать смену календарного дня
    /// Вызывается в начале всех публичных методов для автоматического rollover
    /// Rollover срабатывает в локальную полуночь (00:00 по местному времени).
    pub fn ensure_correct_day(&self) -> Result<(), String> {
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        // Локальная дата «сегодня» — rollover в 00:00 по местному времени
        let today_local = Local::now().date_naive();

        // Если day_start не установлен, устанавливаем текущий день
        let saved_day_local = if let Some(day_start_ts) = day_start {
            let utc_dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
            utc_dt.with_timezone(&Local).date_naive()
        } else {
            // Если day_start не установлен, устанавливаем текущий день
            let now_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs();
            let mut day_start_mutex = self
                .day_start_timestamp
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *day_start_mutex = Some(now_timestamp);
            return Ok(()); // Первый запуск - день установлен
        };

        // Если день не изменился, ничего не делаем
        if saved_day_local == today_local {
            return Ok(());
        }

        // GUARD: Проверка на разумность смены дня (не более 1 дня назад/вперед)
        let days_diff = (today_local - saved_day_local).num_days().abs();
        if days_diff > 1 {
            warn!(
                "[DAY_ROLLOVER] Suspicious day change: {} → {} ({} days). \
                Possible timezone change or system clock manipulation.",
                saved_day_local.format("%Y-%m-%d"),
                today_local.format("%Y-%m-%d"),
                days_diff
            );
            // Все равно выполняем rollover, но логируем предупреждение
        }

        // День изменился (локальная полуночь) — выполняем rollover
        info!(
            "[DAY_ROLLOVER] Day changed: {} → {} (local midnight)",
            saved_day_local.format("%Y-%m-%d"),
            today_local.format("%Y-%m-%d")
        );
        self.rollover_day(saved_day_local, today_local)
    }

    /// Обработать смену дня (rollover)
    /// Вызывается автоматически при обнаружении смены календарного дня
    fn rollover_day(
        &self,
        old_day: chrono::NaiveDate,
        new_day: chrono::NaiveDate,
    ) -> Result<(), String> {
        info!(
            "[DAY_ROLLOVER] Rolling over from {} to {}",
            old_day.format("%Y-%m-%d"),
            new_day.format("%Y-%m-%d")
        );

        // Проверяем состояние FSM
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        let was_running = matches!(&*state, TimerState::Running { .. });
        drop(state); // Освобождаем lock перед дальнейшими операциями

        // Если таймер был RUNNING, нужно корректно зафиксировать время до полуночи
        if was_running {
            // Получаем timestamp полуночи (локальная 00:00 нового дня = конец старого дня)
            let old_day_end = new_day
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
                .ok_or_else(|| "Failed to create old day end timestamp".to_string())?
                .timestamp() as u64;

            // Получаем started_at_ms и started_at_instant из состояния
            // GUARD: Проверка расхождения между SystemTime и Instant (clock skew detection)
            let (started_at_ms, started_at_instant) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                match &*state {
                    TimerState::Running {
                        started_at_ms,
                        started_at_instant,
                        ..
                    } => (*started_at_ms, *started_at_instant),
                    _ => {
                        drop(state);
                        return Err("Timer state changed during rollover".to_string());
                    }
                }
            };
            let started_at_secs = started_at_ms / 1000;

            // GUARD: Clock skew detection - сравниваем SystemTime и Instant
            let now_system = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get system timestamp: {}", e))?
                .as_secs();
            let now_instant = Instant::now();

            let system_time_elapsed = now_system.saturating_sub(started_at_secs);
            let instant_elapsed = now_instant.duration_since(started_at_instant).as_secs();

            // Вычисляем расхождение (clock skew)
            let clock_skew = if system_time_elapsed > instant_elapsed {
                system_time_elapsed - instant_elapsed
            } else {
                instant_elapsed - system_time_elapsed
            };

            // Если расхождение > 60 секунд, это clock skew
            if clock_skew > 60 {
                warn!(
                    "[CLOCK_SKEW] System time changed during timer run. \
                    System elapsed: {}s, Instant elapsed: {}s, Skew: {}s. \
                    Using Instant as source of truth for elapsed time.",
                    system_time_elapsed, instant_elapsed, clock_skew
                );
            }

            // Вычисляем время до полуночи (если started_at был до полуночи)
            // ВАЖНО: Для расчета времени до полуночи используем SystemTime (started_at_secs),
            // так как Instant не имеет связи с календарным временем.
            // Но при наличии clock skew мы ограничиваем результат Instant elapsed.
            if started_at_secs < old_day_end {
                let time_until_midnight = old_day_end - started_at_secs;

                // GUARD: Проверка на разумность времени до полуночи (не более 24 часов)
                // Дополнительно: если есть clock skew, ограничиваем Instant elapsed
                let time_until_midnight = if time_until_midnight > 24 * 3600 {
                    warn!(
                        "[DAY_ROLLOVER] Suspicious time until midnight: {}s (> 24h). \
                        Possible clock manipulation. Using 24h as maximum.",
                        time_until_midnight
                    );
                    // Ограничиваем максимум 24 часами
                    24 * 3600
                } else if clock_skew > 60 && time_until_midnight > instant_elapsed + clock_skew {
                    // Wall clock прыгнул вперёд (NTP, ручная смена) — ограничиваем instant_elapsed
                    warn!(
                        "[CLOCK_SKEW] Time until midnight ({}) exceeds Instant elapsed ({}) + skew ({}). \
                        Limiting to Instant elapsed to prevent time loss.",
                        time_until_midnight, instant_elapsed, clock_skew
                    );
                    instant_elapsed
                } else if system_time_elapsed < instant_elapsed && clock_skew > 5 {
                    // Instant идёт быстрее wall (TSC drift на Windows) — ограничиваем wall
                    let capped = time_until_midnight.min(system_time_elapsed);
                    warn!(
                        "[CLOCK_SKEW] Instant faster than wall (TSC drift). \
                        Limiting time_until_midnight {} to system elapsed {}.",
                        time_until_midnight, capped
                    );
                    capped
                } else {
                    time_until_midnight
                };

                // Обновляем accumulated_seconds (время за старый день)
                // FIX: Защита от переполнения - используем saturating_add
                let mut accumulated = self
                    .accumulated_seconds
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                let old_value = *accumulated;
                *accumulated = accumulated.saturating_add(time_until_midnight);
                if old_value > *accumulated {
                    // Произошло насыщение (переполнение предотвращено)
                    warn!(
                        "[DAY_ROLLOVER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                        old_value, time_until_midnight, *accumulated
                    );
                }
                drop(accumulated);

                info!(
                    "[DAY_ROLLOVER] Added {} seconds from old day (before midnight)",
                    time_until_midnight
                );
            }

            // Hubstaff-style: НЕ останавливаем таймер — обнуляем Today и продолжаем.
            // Сохраняем accumulated = time_until_midnight для полной длительности при stop.
            let elapsed_in_new_day = now_system.saturating_sub(old_day_end);
            let new_started_at_instant = Instant::now() - Duration::from_secs(elapsed_in_new_day);

            let mut state = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *state = TimerState::Running {
                started_at_ms: old_day_end * 1000,
                started_at_instant: new_started_at_instant,
                #[cfg(target_os = "windows")]
                started_at_tick64_ms: get_tick64_ms(),
            };
            drop(state);

            info!("[DAY_ROLLOVER] Timer continues running (Hubstaff-style), Today reset");
        }

        // Обнуляем accumulated_seconds для нового дня (только если НЕ was_running)
        // При was_running accumulated сохраняем для полной длительности сессии
        if !was_running {
            let mut accumulated = self
                .accumulated_seconds
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *accumulated = 0;
            drop(accumulated);
        }

        // Обновляем day_start_timestamp на новый день (локальная полночь)
        let new_day_start = new_day
            .and_hms_opt(0, 0, 0)
            .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
            .ok_or_else(|| "Failed to create new day start timestamp".to_string())?
            .timestamp() as u64;

        // GUARD: Проверка, что rollover не выполняется дважды
        let current_day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        if let Some(current_ts) = current_day_start {
            let current_day = chrono::DateTime::<Utc>::from_timestamp(current_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?
                .date_naive();

            // Если день уже обновлен, это двойной вызов
            if current_day == new_day {
                warn!(
                    "[DAY_ROLLOVER] Day already rolled over to {}, skipping duplicate rollover",
                    new_day.format("%Y-%m-%d")
                );
                return Ok(());
            }
        }

        let mut day_start = self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        *day_start = Some(new_day_start);
        drop(day_start);

        // Сохраняем новое состояние в БД
        if let Err(e) = self.save_state() {
            warn!("[DAY_ROLLOVER] Failed to save state after rollover: {}", e);
            // Не возвращаем ошибку - rollover выполнен, сохранение можно повторить
        }

        info!(
            "[DAY_ROLLOVER] Rollover completed. New day: {}",
            new_day.format("%Y-%m-%d")
        );
        Ok(())
    }

    pub fn reset_day(&self) -> Result<(), String> {
        // Проверяем состояние - нельзя сбрасывать день если таймер RUNNING
        let is_running = {
            let state_lock = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            matches!(&*state_lock, TimerState::Running { .. })
        };

        if is_running {
            // Если таймер работает, сначала останавливаем его
            // Это предотвращает потерю времени
            self.stop()?;
        }

        // Теперь безопасно сбрасываем (таймер Stopped или Paused)

        // Теперь безопасно сбрасываем
        let mut accumulated = self
            .accumulated_seconds
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let mut day_start = self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        *accumulated = 0;
        *day_start = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs(),
        );

        Ok(())
    }
}
