use serde::Serialize;
use std::collections::HashMap;
/// Статистика очереди синхронизации
#[derive(Serialize)]
pub struct QueueStats {
    pub pending_count: i32,
    pub failed_count: i32,
    pub sent_count: i32,
    pub pending_by_type: HashMap<String, i32>,
}

/// Информация о failed задаче
#[derive(serde::Serialize)]
pub struct FailedTaskInfo {
    pub id: i64,
    pub entity_type: String,
    pub payload: String,
    pub retry_count: i32,
    pub created_at: i64,
    pub last_retry_at: Option<i64>,
    pub error_message: Option<String>,
}

/// Результат обновления токена
#[derive(Debug)]
pub struct TokenRefreshResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Serialize)]
pub struct ActiveWindowInfo {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub url: Option<String>,
    pub domain: Option<String>,
}
