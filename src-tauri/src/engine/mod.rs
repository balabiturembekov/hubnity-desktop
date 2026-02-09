use crate::Database;
use std::sync::{Arc, Mutex};
mod core;
mod db;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Timer Engine - строгая FSM
/// Все операции атомарны через один Mutex
pub struct TimerEngine {
    /// Состояние FSM - единственный источник истины
    /// Внутри Running хранится started_at_instant
    pub(crate) state: Arc<Mutex<TimerState>>,
    /// Накопленное время за день (обновляется только при pause/stop)
    pub(crate) accumulated_seconds: Arc<Mutex<u64>>,
    /// Unix timestamp начала дня (для daily reset)
    pub(crate) day_start_timestamp: Arc<Mutex<Option<u64>>>,
    /// База данных для персистентности
    pub(crate) db: Option<Arc<Database>>,
}
/// Состояние таймера - строгая FSM
/// Невозможные состояния физически невозможны
#[derive(Debug, Clone)]
pub enum TimerState {
    /// Таймер остановлен
    Stopped,
    /// Таймер работает - хранит Instant начала сессии
    Running {
        started_at: u64,             // Unix timestamp (секунды) для API
        started_at_instant: Instant, // Монотонное время (для расчетов)
    },
    /// Таймер на паузе
    Paused,
}
/// Ответ для API - упрощенная версия состояния (без Instant)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerStateResponse {
    #[serde(flatten)]
    pub state: TimerStateForAPI,
    pub elapsed_seconds: u64,
    pub accumulated_seconds: u64,   // Накопленное время за день
    pub session_start: Option<u64>, // Unix timestamp начала сессии (только для Running)
    pub day_start: Option<u64>,     // Unix timestamp начала дня
}

/// Упрощенная версия TimerState для API (без Instant)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(tag = "state")]
pub enum TimerStateForAPI {
    Stopped,
    Running { started_at: u64 },
    Paused,
}

impl TimerEngine {
    /// Создать новый TimerEngine без БД (для тестов или fallback)
    #[cfg(test)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(TimerState::Stopped)),
            accumulated_seconds: Arc::new(Mutex::new(0)),
            day_start_timestamp: Arc::new(Mutex::new(None)),
            db: None,
        }
    }
}

// Сериализация для API (без Instant)
impl Serialize for TimerState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            TimerState::Stopped => serializer.serialize_unit_variant("TimerState", 0, "STOPPED"),
            TimerState::Running { started_at, .. } => {
                use serde::ser::SerializeStruct;
                let mut state = serializer.serialize_struct("Running", 2)?;
                state.serialize_field("state", "RUNNING")?;
                state.serialize_field("started_at", started_at)?;
                state.end()
            }
            TimerState::Paused => serializer.serialize_unit_variant("TimerState", 2, "PAUSED"),
        }
    }
}
