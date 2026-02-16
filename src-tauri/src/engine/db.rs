use crate::engine::TimerEngine;
use crate::engine::TimerState;
use crate::Database;
use chrono::{Local, Utc};
use std::sync::{Arc, Mutex};
use tracing::{error, info, warn};

impl TimerEngine {
    /// Сохранить состояние в БД
    /// Публичный метод для явного сохранения (например, при закрытии приложения)
    pub fn save_state(&self) -> Result<(), String> {
        self.save_state_with_accumulated_override(None)
    }

    /// Сохранить состояние в БД с переопределением accumulated
    /// CRITICAL FIX: Используется для атомарного сохранения после pause/stop
    pub fn save_state_with_accumulated_override(
        &self,
        accumulated_override: Option<u64>,
    ) -> Result<(), String> {
        let db = match &self.db {
            Some(db) => db,
            None => return Ok(()), // Нет БД - пропускаем
        };

        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let accumulated = if let Some(override_val) = accumulated_override {
            // Используем переданное значение (для атомарности)
            override_val
        } else {
            // Используем текущее значение из памяти
            *self
                .accumulated_seconds
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?
        };
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        // Определяем день (локальная дата — согласовано с ensure_correct_day / rollover по местной полуночи)
        let day = if let Some(day_start_ts) = day_start {
            let utc_dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
            utc_dt.with_timezone(&Local).format("%Y-%m-%d").to_string()
        } else {
            Local::now().format("%Y-%m-%d").to_string()
        };

        // Определяем строковое представление состояния и started_at_ms (миллисекунды для точной синхронизации)
        let (state_str, started_at) = match &*state {
            TimerState::Stopped => ("stopped", None),
            TimerState::Running { started_at_ms, .. } => ("running", Some(*started_at_ms)),
            TimerState::Paused => ("paused", None),
        };

        db.save_timer_state(&day, accumulated, state_str, started_at)
            .map_err(|e| format!("Failed to save state to DB: {}", e))?;

        Ok(())
    }

    /// Инициализация с базой данных
    pub fn with_db(db: Arc<Database>) -> Self {
        let engine = Self {
            state: Arc::new(Mutex::new(TimerState::Stopped)),
            accumulated_seconds: Arc::new(Mutex::new(0)),
            day_start_timestamp: Arc::new(Mutex::new(None)),
            db: Some(db),
            restored_from_running: Arc::new(Mutex::new(false)),
        };

        // Восстанавливаем состояние из БД
        if let Err(e) = engine.restore_state() {
            error!("[TIMER] Failed to restore state from DB: {}", e);
        }

        engine
    }

    /// Восстановить состояние из БД
    /// GUARD: НИКОГДА не крашиться на ошибке восстановления
    fn restore_state(&self) -> Result<(), String> {
        let db = match &self.db {
            Some(db) => db,
            None => {
                info!("[RECOVERY] No database available, starting with default state");
                return Ok(()); // Нет БД - пропускаем
            }
        };

        // GUARD: Обработка всех возможных ошибок
        match db.load_timer_state() {
            Ok(Some((day_str, accumulated, state_str, saved_started_at))) => {
                let today_local = Local::now().format("%Y-%m-%d").to_string();

                if day_str == today_local {
                    // CRITICAL FIX: Если было running, добавляем elapsed time к accumulated
                    // С защитой от clock skew
                    // Миграция: saved_started_at < 1e12 = секунды (старый формат), иначе миллисекунды
                    let final_accumulated = if state_str == "running" && saved_started_at.is_some()
                    {
                        let raw = saved_started_at.unwrap();
                        let started_at_secs = if raw < 1_000_000_000_000 {
                            raw // старый формат: секунды
                        } else {
                            raw / 1000 // новый формат: миллисекунды
                        };
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs();

                        // CRITICAL FIX: Clock skew detection
                        // ДОКАЗАНО: Если now < started_at_secs, часы были переведены назад
                        if now < started_at_secs {
                            // ДОКАЗАНО: Clock skew detected - часы переведены назад
                            warn!(
                                "[RECOVERY] Clock skew detected: now ({}) < started_at ({}). Not adding elapsed time to prevent time loss.",
                                now, started_at_secs
                            );
                            // НЕ добавляем elapsed time - используем только saved accumulated
                            accumulated
                        } else {
                            let elapsed_since_save = now.saturating_sub(started_at_secs);

                            // CRITICAL FIX: Проверка на нереалистично большое время (> 24 часов)
                            // ДОКАЗАНО: Если elapsed > 24 часов, вероятно clock skew или системная ошибка
                            const MAX_REASONABLE_ELAPSED: u64 = 24 * 60 * 60; // 24 часа
                            if elapsed_since_save > MAX_REASONABLE_ELAPSED {
                                warn!(
                                    "[RECOVERY] Unrealistic time gap detected: {}s ({} hours). Possible clock skew. Not adding elapsed time.",
                                    elapsed_since_save, elapsed_since_save / 3600
                                );
                                // НЕ добавляем elapsed time - используем только saved accumulated
                                accumulated
                            } else {
                                // ДОКАЗАНО: Elapsed time разумен - добавляем к accumulated
                                let new_accumulated =
                                    accumulated.saturating_add(elapsed_since_save);
                                info!(
                                    "[RECOVERY] Timer was running: accumulated={}s, started_at={}, elapsed_since_save={}s, final_accumulated={}s",
                                    accumulated, started_at_secs, elapsed_since_save, new_accumulated
                                );
                                new_accumulated
                            }
                        }
                    } else {
                        // ДОКАЗАНО: State не был running - используем saved accumulated
                        accumulated
                    };

                    // Восстанавливаем накопленное время
                    match self.accumulated_seconds.lock() {
                        Ok(mut acc) => *acc = final_accumulated,
                        Err(e) => {
                            error!("[RECOVERY] Mutex poisoned for accumulated_seconds: {}. Using default (0).", e);
                            // Продолжаем с дефолтным значением
                        }
                    }

                    // Восстанавливаем состояние
                    let (state, set_restored_flag) = match state_str.as_str() {
                        "stopped" => (TimerState::Stopped, false),
                        "paused" => (TimerState::Paused, false),
                        "running" => {
                            // Если было running, восстанавливаем как paused (безопаснее)
                            // Пользователь может возобновить вручную (этап 4: покажем уведомление)
                            (TimerState::Paused, true)
                        }
                        _ => {
                            warn!(
                                "[RECOVERY] Unknown state '{}', defaulting to Stopped",
                                state_str
                            );
                            (TimerState::Stopped, false)
                        }
                    };

                    if set_restored_flag {
                        if let Ok(mut flag) = self.restored_from_running.lock() {
                            *flag = true;
                        }
                    }

                    match self.state.lock() {
                        Ok(mut state_mutex) => *state_mutex = state,
                        Err(e) => {
                            error!(
                                "[RECOVERY] Mutex poisoned for state: {}. Using default (Stopped).",
                                e
                            );
                            // Продолжаем с дефолтным состоянием
                        }
                    }

                    info!(
                        "[RECOVERY] Restored state: day={}, accumulated={}s, state={}",
                        day_str, final_accumulated, state_str
                    );
                } else {
                    // День изменился - сбрасываем
                    info!(
                        "[RECOVERY] Day changed ({} → {}), resetting state",
                        day_str, today_local
                    );
                    // Не восстанавливаем состояние
                }
            }
            Ok(None) => {
                // Нет сохраненного состояния - это нормально для первого запуска
                info!("[RECOVERY] No saved state found, starting fresh");
            }
            Err(e) => {
                // GUARD: НИКОГДА не крашиться на ошибке восстановления
                error!(
                    "[RECOVERY] Failed to load state from DB: {}. Starting with default state.",
                    e
                );
                // Продолжаем с дефолтным состоянием (Stopped, accumulated=0)
            }
        }

        Ok(())
    }

    /// Сбросить состояние таймера (при смене пользователя)
    pub fn reset_state(&self) -> Result<(), String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *state = TimerState::Stopped;
        }
        {
            let mut acc = self
                .accumulated_seconds
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *acc = 0;
        }
        {
            let mut day = self
                .day_start_timestamp
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *day = None;
        }
        if let Ok(mut flag) = self.restored_from_running.lock() {
            *flag = false;
        }
        let db = match &self.db {
            Some(db) => db,
            None => return Ok(()),
        };
        let day = Local::now().format("%Y-%m-%d").to_string();
        db.save_timer_state(&day, 0, "stopped", None)
            .map_err(|e| format!("Failed to save reset state: {}", e))?;
        Ok(())
    }
}
