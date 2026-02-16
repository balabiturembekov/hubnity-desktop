use crate::engine::TimerEngine;
use crate::engine::TimerState;
use crate::engine::{TimerStateForAPI, TimerStateResponse};
use chrono::{Local, Utc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

impl TimerEngine {
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

                eprintln!("[SLEEP] System sleep detected, pausing timer");

                // Используем существующий метод pause() для корректного перехода FSM
                self.pause()?;

                eprintln!("[SLEEP] Timer paused successfully due to system sleep");
                Ok(())
            }
            TimerState::Paused | TimerState::Stopped => {
                // Уже на паузе или остановлен - ничего не делаем (идемпотентно)
                eprintln!("[SLEEP] System sleep detected, but timer is already paused/stopped");
                Ok(())
            }
        }
    }

    /// Обработка системного wake (вызывается из setup_sleep_wake_handlers при старте приложения)
    /// НЕ возобновляем автоматически - оставляем PAUSED
    pub fn handle_system_wake(&self) -> Result<(), String> {
        eprintln!("[WAKE] System wake detected");

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

        eprintln!(
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
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Если это первый старт за день, фиксируем начало дня
                let mut day_start = self
                    .day_start_timestamp
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                if day_start.is_none() {
                    *day_start = Some(now_timestamp);
                }
                drop(day_start); // Освобождаем lock

                // Переход в Running с данными внутри
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // Сохраняем состояние в БД
                if let Err(e) = self.save_state() {
                    error!("[TIMER] Failed to save state after start: {}", e);
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
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в других переходах start())
                if let Err(e) = self.save_state() {
                    error!(
                        "[TIMER] Failed to save state after start (Paused→Running): {}",
                        e
                    );
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
        self.pause_internal(Some(work_elapsed_secs))
    }

    fn pause_internal(&self, work_elapsed_override: Option<u64>) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at,
                started_at_instant,
                ..
            } => {
                // Допустимый переход: Running → Paused
                let now = Instant::now();
                let monotonic_elapsed = now.duration_since(*started_at_instant).as_secs();
                let now_wall = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let wall_elapsed = now_wall.saturating_sub(*started_at);
                let base_elapsed = wall_elapsed.min(monotonic_elapsed); // Fix TSC drift на Windows
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

                // CRITICAL FIX: Обновляем accumulated в памяти ТОЛЬКО после успешного сохранения
                // Это гарантирует, что если save_state() падает, accumulated не обновлен
                // Переход в Paused (started_at_instant удаляется из state)
                *state = TimerState::Paused;
                drop(state); // Освобождаем lock перед сохранением

                // CRITICAL FIX: Сохраняем состояние с новым accumulated в одной транзакции
                // Если сохранение успешно, обновляем accumulated в памяти
                match self.save_state_with_accumulated_override(Some(new_accumulated)) {
                    Ok(_) => {
                        // ДОКАЗАНО: Сохранение успешно - обновляем accumulated в памяти
                        let mut accumulated = self
                            .accumulated_seconds
                            .lock()
                            .map_err(|e| format!("Mutex poisoned: {}", e))?;
                        *accumulated = new_accumulated;
                        // Lock освобождается автоматически
                    }
                    Err(e) => {
                        // ДОКАЗАНО: Сохранение не удалось - accumulated НЕ обновлен в памяти
                        // State уже изменен на Paused, но accumulated остался старым
                        // Это безопаснее, чем обновить accumulated до сохранения
                        error!("[TIMER] Failed to save state after pause: {}", e);
                        // Возвращаем ошибку, чтобы вызывающий код знал о проблеме
                        return Err(format!("Failed to save state after pause: {}", e));
                    }
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
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в start(), pause(), stop())
                if let Err(e) = self.save_state() {
                    error!("[TIMER] Failed to save state after resume: {}", e);
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
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at,
                started_at_instant,
                ..
            } => {
                // Допустимый переход: Running → Stopped
                let now = Instant::now();
                let monotonic_elapsed = now.duration_since(*started_at_instant).as_secs();
                let now_wall = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let wall_elapsed = now_wall.saturating_sub(*started_at);
                let session_elapsed = wall_elapsed.min(monotonic_elapsed); // Fix TSC drift на Windows

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

                // Переход в Stopped
                *state = TimerState::Stopped;
                drop(state); // Освобождаем lock перед сохранением

                // Сбрасываем флаг восстановления после wake
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }

                // CRITICAL FIX: Сохраняем состояние с новым accumulated в одной транзакции
                match self.save_state_with_accumulated_override(Some(new_accumulated)) {
                    Ok(_) => {
                        // ДОКАЗАНО: Сохранение успешно - обновляем accumulated в памяти
                        let mut accumulated = self
                            .accumulated_seconds
                            .lock()
                            .map_err(|e| format!("Mutex poisoned: {}", e))?;
                        *accumulated = new_accumulated;
                    }
                    Err(e) => {
                        // ДОКАЗАНО: Сохранение не удалось - accumulated НЕ обновлен
                        error!("[TIMER] Failed to save state after stop: {}", e);
                        return Err(format!("Failed to save state after stop: {}", e));
                    }
                }

                Ok(())
            }
            TimerState::Paused => {
                // Допустимый переход: Paused → Stopped (accumulated уже сохранен)
                *state = TimerState::Stopped;
                drop(state); // Освобождаем lock перед сохранением

                // Сбрасываем флаг восстановления после wake
                if let Ok(mut f) = self.restored_from_running.lock() {
                    *f = false;
                }

                // Сохраняем состояние в БД
                if let Err(e) = self.save_state() {
                    error!("[TIMER] Failed to save state after stop: {}", e);
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

        let now_wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // Расчет elapsed только для RUNNING состояния
        // Используем min(wall, monotonic): wall clock для пользователя (fix TSC drift на Windows),
        // monotonic ограничивает при сне (wall прыгает вперёд).
        let (elapsed_seconds, session_start, needs_sleep_handling) = match &*state {
            TimerState::Running {
                started_at,
                started_at_instant,
            } => {
                let now = Instant::now();
                let monotonic_elapsed = now.duration_since(*started_at_instant).as_secs();
                let wall_elapsed = now_wall.saturating_sub(*started_at);

                // Sleep detection: реальный сон = разрыв между wall-clock и monotonic.
                const SLEEP_GAP_THRESHOLD_SECONDS: u64 = 5 * 60; // 5 минут разрыва = сон
                let is_sleep = wall_elapsed > monotonic_elapsed
                    && (wall_elapsed - monotonic_elapsed) >= SLEEP_GAP_THRESHOLD_SECONDS;

                // min(wall, monotonic): на Windows Instant (QPC) может идти быстрее реального
                // времени (TSC drift). Wall clock = то, что видит пользователь. При сне
                // monotonic меньше wall — не считаем время сна.
                let session_elapsed = wall_elapsed.min(monotonic_elapsed);

                // Защита от переполнения при вычислении elapsed_seconds
                let elapsed = accumulated.saturating_add(session_elapsed);
                (elapsed, Some(*started_at), is_sleep)
            }
            TimerState::Paused | TimerState::Stopped => {
                // В PAUSED и STOPPED показываем только accumulated
                (accumulated, None, false)
            }
        };

        // Если обнаружен sleep (большой пропуск времени), вызываем handle_system_sleep для паузы
        if needs_sleep_handling {
            drop(state);
            if let Err(e) = self.handle_system_sleep() {
                warn!("[SLEEP_DETECTION] handle_system_sleep failed: {}", e);
            }
            return self.get_state_internal(depth + 1);
        }

        // Создаем упрощенную версию state для API (без Instant)
        let state_for_response = match &*state {
            TimerState::Stopped => TimerStateForAPI::Stopped,
            TimerState::Running { started_at, .. } => TimerStateForAPI::Running {
                started_at: *started_at,
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

        // today_seconds: для "Today" display. При rollover (started_at == day_start) — только время с полуночи.
        let today_seconds = match &*state {
            TimerState::Running { started_at, .. } => {
                let rolled_over = day_start.map_or(false, |ds| *started_at == ds);
                if rolled_over {
                    day_start
                        .map(|ds| now_wall.saturating_sub(ds))
                        .unwrap_or(accumulated)
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
            day_start,
            today_seconds,
            restored_from_running,
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

            // Получаем started_at и started_at_instant из состояния
            // GUARD: Проверка расхождения между SystemTime и Instant (clock skew detection)
            let (started_at, started_at_instant) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                match &*state {
                    TimerState::Running {
                        started_at,
                        started_at_instant,
                    } => (*started_at, *started_at_instant),
                    _ => {
                        drop(state);
                        return Err("Timer state changed during rollover".to_string());
                    }
                }
            };

            // GUARD: Clock skew detection - сравниваем SystemTime и Instant
            let now_system = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get system timestamp: {}", e))?
                .as_secs();
            let now_instant = Instant::now();

            let system_time_elapsed = now_system.saturating_sub(started_at);
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
            // ВАЖНО: Для расчета времени до полуночи используем SystemTime (started_at),
            // так как Instant не имеет связи с календарным временем.
            // Но при наличии clock skew мы ограничиваем результат Instant elapsed.
            if started_at < old_day_end {
                let time_until_midnight = old_day_end - started_at;

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
            let new_started_at_instant =
                Instant::now() - Duration::from_secs(elapsed_in_new_day);

            let mut state = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *state = TimerState::Running {
                started_at: old_day_end,
                started_at_instant: new_started_at_instant,
            };
            drop(state);

            info!(
                "[DAY_ROLLOVER] Timer continues running (Hubstaff-style), Today reset"
            );
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
