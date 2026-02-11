use crate::auth::AuthManager;
#[cfg(test)]
use crate::models::TokenRefreshResult;
use crate::Database;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// Ошибки синхронизации (для разбора и логирования)
#[derive(Debug)]
pub enum SyncError {
    ParsePayload(String),
    Auth(String),
    Network(String),
    Http { status: u16, message: String },
    UnknownOperation(String),
    Db(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::ParsePayload(s) => write!(f, "Parse payload: {}", s),
            SyncError::Auth(s) => write!(f, "Auth: {}", s),
            SyncError::Network(s) => write!(f, "Network: {}", s),
            SyncError::Http { status, message } => write!(f, "HTTP {}: {}", status, message),
            SyncError::UnknownOperation(s) => write!(f, "Unknown operation: {}", s),
            SyncError::Db(s) => write!(f, "DB: {}", s),
        }
    }
}

/// Конфигурация синхронизации (api_base_url, таймауты)
#[derive(Clone)]
pub struct SyncConfig {
    pub api_base_url: String,
    pub http_timeout_secs: u64,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            api_base_url: "https://app.automatonsoft.de/api".to_string(),
            http_timeout_secs: 120,
        }
    }
}

/// Приоритет задачи синхронизации (используется sync и database)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TaskPriority {
    Critical = 0, // start, stop
    High = 1,     // pause, resume
    Normal = 2,   // screenshots, activities
}

impl TaskPriority {
    pub fn from_entity_type(entity_type: &str) -> Self {
        if entity_type == "time_entry_start" || entity_type == "time_entry_stop" {
            TaskPriority::Critical
        } else if entity_type.starts_with("time_entry_") {
            TaskPriority::High
        } else {
            TaskPriority::Normal
        }
    }
}

/// Менеджер синхронизации для обработки offline queue
/// PRODUCTION-GRADE: single-flight sync, fresh tokens, adaptive batching
#[derive(Clone)]
pub struct SyncManager {
    pub(crate) db: Arc<Database>,
    pub(crate) api_base_url: String,
    pub(crate) auth_manager: Arc<AuthManager>,
    pub(crate) sync_lock: Arc<tokio::sync::Mutex<()>>,
    pub(crate) client: reqwest::Client,
}

impl SyncManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self::new_with_config(db, SyncConfig::default())
    }

    pub fn new_with_config(db: Arc<Database>, config: SyncConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.http_timeout_secs))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            db,
            api_base_url: config.api_base_url.clone(),
            auth_manager: Arc::new(AuthManager::new(config.api_base_url)),
            sync_lock: Arc::new(tokio::sync::Mutex::new(())),
            client,
        }
    }

    /// Вычислить адаптивный batch size на основе количества pending задач
    /// PRODUCTION: Адаптивный размер batch для эффективной синхронизации
    fn calculate_batch_size(&self, pending_count: i32) -> i32 {
        match pending_count {
            0..=20 => 5,     // Маленькая очередь - маленький batch
            21..=100 => 20,  // Средняя очередь - средний batch
            101..=500 => 50, // Большая очередь - большой batch
            _ => 100,        // Очень большая очередь - максимальный batch
        }
    }

    /// Обновить токен через refresh (используется в тестах; в sync_task вызывается auth_manager.refresh_token)
    #[cfg(test)]
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<TokenRefreshResult, String> {
        let url = format!("{}/auth/refresh", self.api_base_url);
        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| format!("Network error during token refresh: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Token refresh failed with status: {}",
                response.status()
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

        let access_token = json["access_token"]
            .as_str()
            .ok_or_else(|| "Missing access_token in refresh response".to_string())?
            .to_string();

        let refresh_token = json["refresh_token"].as_str().map(|s| s.to_string());

        Ok(TokenRefreshResult {
            access_token,
            refresh_token,
        })
    }

    /// Добавить time entry операцию в очередь синхронизации
    /// PRODUCTION: Токены НЕ сохраняются в payload, получаются через AuthManager при синхронизации
    /// FIX: Отменяет противоположные операции (resume <-> pause) перед добавлением новой
    pub fn enqueue_time_entry(
        &self,
        operation: &str,
        payload: serde_json::Value,
        _access_token: String, // Не используется - оставлен для обратной совместимости
        _refresh_token: Option<String>, // Не используется - оставлен для обратной совместимости
    ) -> Result<i64, String> {
        // PRODUCTION: Токены НЕ сохраняются в payload
        // Они будут получаться через AuthManager.get_fresh_token() при синхронизации
        
        // FIX: Отменяем противоположные операции (resume <-> pause) перед добавлением новой
        // Это предотвращает конфликты когда пользователь быстро нажимает resume/pause
        if operation == "resume" || operation == "pause" {
            // Для операций resume/pause payload содержит {"id": "timeEntryId"}
            if let Some(time_entry_id) = payload.get("id").and_then(|v| v.as_str()) {
                if let Err(e) = self.db.cancel_opposite_time_entry_operations(operation, time_entry_id) {
                    warn!(
                        "[SYNC] Failed to cancel opposite operations for {}: {}",
                        operation, e
                    );
                    // Продолжаем - это не критично, синхронизация обработает конфликт
                }
            }
        }
        
        let payload_str = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize payload: {}", e))?;

        self.db
            .enqueue_sync(&format!("time_entry_{}", operation), &payload_str)
            .map_err(|e| format!("Failed to enqueue time entry: {}", e))
    }

    /// Добавить скриншот в очередь синхронизации
    /// PRODUCTION: Токены НЕ сохраняются в payload
    pub fn enqueue_screenshot(
        &self,
        png_data: Vec<u8>,
        time_entry_id: String,
        _access_token: String, // Не используется - оставлен для обратной совместимости
        _refresh_token: Option<String>, // Не используется - оставлен для обратной совместимости
    ) -> Result<i64, String> {
        use base64::{engine::general_purpose, Engine as _};

        // Конвертируем в base64
        let base64_string = general_purpose::STANDARD.encode(&png_data);
        let image_data = format!("data:image/jpeg;base64,{}", base64_string);

        // PRODUCTION: Токены НЕ сохраняются в payload
        let payload = serde_json::json!({
            "imageData": image_data,
            "timeEntryId": time_entry_id,
        });

        let payload_str = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize payload: {}", e))?;

        self.db
            .enqueue_sync("screenshot", &payload_str)
            .map_err(|e| format!("Failed to enqueue screenshot: {}", e))
    }

    /// Построить и отправить HTTP-запрос для time_entry операции
    fn send_time_entry_request(
        &self,
        operation: &str,
        payload_json: &serde_json::Value,
        access_token: &str,
        idempotency_key: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, SyncError> {
        let url = match operation {
            "start" => format!("{}/time-entries", self.api_base_url),
            "pause" => {
                let id = payload_json["id"].as_str().ok_or_else(|| {
                    SyncError::UnknownOperation("Missing id for pause operation".into())
                })?;
                format!("{}/time-entries/{}/pause", self.api_base_url, id)
            }
            "resume" => {
                let id = payload_json["id"].as_str().ok_or_else(|| {
                    SyncError::UnknownOperation("Missing id for resume operation".into())
                })?;
                format!("{}/time-entries/{}/resume", self.api_base_url, id)
            }
            "stop" => {
                let id = payload_json["id"].as_str().ok_or_else(|| {
                    SyncError::UnknownOperation("Missing id for stop operation".into())
                })?;
                format!("{}/time-entries/{}/stop", self.api_base_url, id)
            }
            _ => {
                return Err(SyncError::UnknownOperation(format!(
                    "Unknown time entry operation: {}",
                    operation
                )))
            }
        };

        let method = match operation {
            "start" => self.client.post(&url),
            "pause" | "resume" | "stop" => self.client.put(&url),
            _ => {
                return Err(SyncError::UnknownOperation(format!(
                    "Unknown operation: {}",
                    operation
                )))
            }
        };

        let mut request = method
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", access_token));
        if let Some(key) = idempotency_key {
            request = request.header("X-Idempotency-Key", key);
        }
        // start: body = payload (projectId, userId, description). pause/resume/stop: id в URL, тело пустое (API часто не ожидает body)
        let body = match operation {
            "start" => payload_json.clone(),
            _ => serde_json::json!({}),
        };
        Ok(request.json(&body))
    }

    /// Построить и отправить HTTP-запрос для screenshot
    fn send_screenshot_request(
        &self,
        payload_json: &serde_json::Value,
        access_token: &str,
        idempotency_key: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, SyncError> {
        let image_data = payload_json["imageData"]
            .as_str()
            .ok_or_else(|| SyncError::UnknownOperation("Missing imageData in payload".into()))?;
        let time_entry_id = payload_json["timeEntryId"]
            .as_str()
            .ok_or_else(|| SyncError::UnknownOperation("Missing timeEntryId in payload".into()))?;

        let payload = serde_json::json!({
            "imageData": image_data,
            "timeEntryId": time_entry_id,
        });

        let url = format!("{}/screenshots", self.api_base_url);
        let mut request = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", access_token));
        if let Some(key) = idempotency_key {
            request = request.header("X-Idempotency-Key", key);
        }
        Ok(request.json(&payload))
    }

    /// Синхронизировать одну задачу из очереди
    /// PRODUCTION: Получает токены через AuthManager (не из payload)
    /// Автоматически обновляет токен при 401 ошибке
    /// CRITICAL FIX: Использует idempotency_key для предотвращения дубликатов
    pub async fn sync_task(
        &self,
        task_id: i64,
        entity_type: String,
        payload: String,
        idempotency_key: Option<String>,
    ) -> Result<bool, SyncError> {
        let payload_json: serde_json::Value =
            serde_json::from_str(&payload).map_err(|e| SyncError::ParsePayload(e.to_string()))?;

        let mut access_token = self
            .auth_manager
            .get_access_token()
            .await
            .map_err(|e| SyncError::Auth(e.to_string()))?;

        let mut refresh_token = self
            .auth_manager
            .get_refresh_token()
            .await
            .map_err(|e| SyncError::Auth(e.to_string()))?;

        let mut retry_with_refresh = true;
        let idempotency_key_ref = idempotency_key.as_deref();

        loop {
            let response_result = if entity_type.starts_with("time_entry_") {
                let operation = entity_type.strip_prefix("time_entry_").unwrap();
                let builder = self.send_time_entry_request(
                    operation,
                    &payload_json,
                    &access_token,
                    idempotency_key_ref,
                )?;
                builder.send().await
            } else if entity_type == "screenshot" {
                let builder = self.send_screenshot_request(
                    &payload_json,
                    &access_token,
                    idempotency_key_ref,
                )?;
                builder.send().await
            } else {
                return Err(SyncError::UnknownOperation(format!(
                    "Unknown entity type: {}",
                    entity_type
                )));
            };

            match response_result {
                Ok(response) => {
                    let status = response.status();

                    // Если 401 и есть refresh_token, обновляем токен
                    if status == 401 && retry_with_refresh {
                        if let Some(refresh) = refresh_token.as_ref() {
                            info!(
                                "[SYNC] Token expired (401), refreshing token for task {}",
                                task_id
                            );

                            match self.auth_manager.refresh_token(refresh).await {
                                Ok(token_result) => {
                                    // Обновляем токены в AuthManager
                                    access_token = token_result.access_token.clone();
                                    if let Some(new_refresh) = token_result.refresh_token {
                                        refresh_token = Some(new_refresh.clone());
                                    }

                                    // PRODUCTION: Сохраняем новые токены в AuthManager (не в payload)
                                    self.auth_manager
                                        .set_tokens(
                                            Some(access_token.clone()),
                                            refresh_token.clone(),
                                        )
                                        .await;

                                    retry_with_refresh = false; // Только одна попытка обновления
                                    continue; // Повторяем запрос с новым токеном
                                }
                                Err(e) => {
                                    let err = SyncError::Auth(e.to_string());
                                    warn!(
                                        "[SYNC] Failed to refresh token for task {}: {}",
                                        task_id, err
                                    );
                                    return Err(err);
                                }
                            }
                        } else {
                            let err = SyncError::Auth(
                                "Token expired (401) but no refresh token available".into(),
                            );
                            warn!("[SYNC] {} for task {}", err, task_id);
                            return Err(err);
                        }
                    }

                    let status_code = status.as_u16();
                    if status.is_success() {
                        return Ok(true);
                    }
                    let body = response.text().await.unwrap_or_default();
                    // State-already-achieved: server says desired state is already there, drop task to stop retries
                    if status_code == 400
                        && (body.contains("Only running entries can be paused")
                            || body.contains("Only paused entries can be resumed")
                            || body.contains("Time entry is already stopped")
                            || body.contains("User already has an active time entry"))
                    {
                        info!(
                            "[SYNC] Task {} HTTP 400 state-already-achieved, dropping task",
                            task_id
                        );
                        return Ok(true);
                    }
                    if status_code == 400 && !body.is_empty() {
                        warn!("[SYNC] Task {} HTTP 400 response body: {}", task_id, body);
                    }
                    let message = if body.is_empty() {
                        status.canonical_reason().unwrap_or("Unknown").into()
                    } else {
                        body
                    };
                    return Err(SyncError::Http {
                        status: status_code,
                        message,
                    });
                }
                Err(e) => {
                    return Err(SyncError::Network(e.to_string()));
                }
            }
        }
    }

    /// Внутренний метод синхронизации (single-flight)
    /// PRODUCTION: Все точки входа сходятся здесь
    async fn run_sync_internal(&self, max_retries: i32) -> Result<usize, SyncError> {
        match self.auth_manager.get_access_token().await {
            Ok(token) => {
                debug!("[SYNC] Token available, length: {}", token.len());
            }
            Err(e) => {
                let msg = format!("[SYNC] Skipping sync (no token): {}", e);
                warn!("{}", msg);
                eprintln!("{}", msg);
                return Ok(0);
            }
        }

        let pending_count = self
            .db
            .get_pending_count_for_batch()
            .map_err(|e| SyncError::Db(format!("get pending count: {}", e)))?;

        info!("[SYNC] run_sync_internal: {} pending tasks", pending_count);
        if pending_count == 0 {
            debug!("[SYNC] No pending tasks, skipping sync");
            return Ok(0);
        }

        // Вычисляем адаптивный batch size
        let batch_size = self.calculate_batch_size(pending_count);

        // Получаем статистику по типам задач для логирования
        let queue_stats = self.db.get_queue_stats().ok();
        let stats_info = if let Some(stats) = queue_stats {
            let type_info: Vec<String> = stats
                .pending_by_type
                .iter()
                .map(|(k, v)| format!("{}: {}", k, v))
                .collect();
            if !type_info.is_empty() {
                format!(" (by type: {})", type_info.join(", "))
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        info!(
            "[SYNC] Starting sync: {} pending tasks{}, batch size: {}",
            pending_count, stats_info, batch_size
        );
        eprintln!("[SYNC] Starting sync: {} pending tasks", pending_count);

        let tasks = self
            .db
            .get_retry_tasks(max_retries, batch_size)
            .map_err(|e| SyncError::Db(format!("get retry tasks: {}", e)))?;

        if tasks.is_empty() {
            eprintln!("[SYNC] No tasks ready for retry (backoff or empty), skipping");
            return Ok(0);
        }

        let mut synced_count = 0;
        let mut failed_in_batch = 0;
        let mut by_type_synced: std::collections::HashMap<String, i32> =
            std::collections::HashMap::new();
        let mut by_type_failed: std::collections::HashMap<String, i32> =
            std::collections::HashMap::new();

        // PRODUCTION: Partial success - обрабатываем все задачи в batch
        // Ошибка одной задачи НЕ останавливает batch
        for (id, entity_type, payload, retry_count, idempotency_key) in tasks {
            info!(
                "[SYNC] Processing task {}: {} (retry {})",
                id, entity_type, retry_count
            );

            match self
                .sync_task(
                    id,
                    entity_type.clone(),
                    payload.clone(),
                    idempotency_key.clone(),
                )
                .await
            {
                Ok(true) => {
                    // CRITICAL FIX: Retry mark_task_sent() с exponential backoff
                    // ДОКАЗАНО: HTTP запрос успешен - задача ДОЛЖНА быть помечена как sent
                    let mut retries = 0;
                    const MAX_RETRIES: u32 = 3;
                    let mut marked = false;

                    while retries < MAX_RETRIES {
                        match self.db.mark_task_sent(id) {
                            Ok(_) => {
                                // ДОКАЗАНО: mark_task_sent успешен
                                marked = true;
                                break;
                            }
                            Err(e) => {
                                retries += 1;
                                if retries >= MAX_RETRIES {
                                    // ДОКАЗАНО: Все попытки исчерпаны - критическая ошибка
                                    error!(
                                        "[SYNC] CRITICAL: Failed to mark task {} sent after {} retries: {}. Task will be retried, causing duplicate.",
                                        id, MAX_RETRIES, e
                                    );
                                    // НЕ увеличиваем synced_count - задача останется pending
                                    // Это лучше, чем потерять задачу, но хуже, чем дубликат
                                    // В production нужен мониторинг таких случаев
                                    break;
                                }
                                // Exponential backoff: 100ms, 200ms, 400ms
                                let delay_ms = 100 * (1 << (retries - 1));
                                warn!(
                                    "[SYNC] Failed to mark task {} sent (attempt {}): {}. Retrying in {}ms...",
                                    id, retries, e, delay_ms
                                );
                                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms))
                                    .await;
                            }
                        }
                    }

                    if marked {
                        // ДОКАЗАНО: Задача помечена как sent - увеличиваем счетчики
                        synced_count += 1;
                        *by_type_synced.entry(entity_type.clone()).or_insert(0) += 1;
                    } else {
                        // ДОКАЗАНО: mark_task_sent не удался после всех попыток
                        // Задача остается pending и будет retried - это лучше, чем потерять задачу
                        // Но может привести к дубликату на сервере
                        // В production нужен мониторинг и ручное вмешательство
                        warn!(
                            "[SYNC] Task {} remains pending after HTTP success due to mark_task_sent failure. Manual intervention may be required.",
                            id
                        );
                    }
                }
                Ok(false) => {
                    // Ошибка сервера (4xx, 5xx)
                    failed_in_batch += 1;
                    *by_type_failed.entry(entity_type.clone()).or_insert(0) += 1;
                    let new_retry_count = retry_count + 1;
                    let error_msg =
                        format!("Server error (4xx/5xx) after {} retries", new_retry_count);
                    if new_retry_count >= max_retries {
                        self.db
                            .update_sync_status_with_error(
                                id,
                                "failed",
                                new_retry_count,
                                Some(&error_msg),
                            )
                            .map_err(|e| SyncError::Db(format!("update status: {}", e)))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|e| SyncError::Db(format!("update status: {}", e)))?;
                        info!(
                            "[SYNC] Task {} will retry later (attempt {})",
                            id, new_retry_count
                        );
                    }
                }
                Err(e) => {
                    failed_in_batch += 1;
                    *by_type_failed.entry(entity_type.clone()).or_insert(0) += 1;
                    let new_retry_count = retry_count + 1;
                    let error_msg = e.to_string();
                    if new_retry_count >= max_retries {
                        self.db
                            .update_sync_status_with_error(
                                id,
                                "failed",
                                new_retry_count,
                                Some(&error_msg),
                            )
                            .map_err(|err| SyncError::Db(format!("update status: {}", err)))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|err| SyncError::Db(format!("update status: {}", err)))?;
                        info!(
                            "[SYNC] Task {} will retry later (attempt {}): {}",
                            id, new_retry_count, error_msg
                        );
                    }
                }
            }
        }

        if failed_in_batch > 0 {
            info!(
                "[SYNC] Batch completed: {} synced, {} failed",
                synced_count, failed_in_batch
            );
        }

        // Финальное логирование с детальной статистикой
        let synced_by_type: Vec<String> = by_type_synced
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();
        let failed_by_type: Vec<String> = by_type_failed
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();

        if synced_count > 0 || failed_in_batch > 0 {
            let mut log_parts = vec![format!("Synced: {} tasks", synced_count)];
            if !synced_by_type.is_empty() {
                log_parts.push(format!("({})", synced_by_type.join(", ")));
            }
            if failed_in_batch > 0 {
                log_parts.push(format!("Failed: {} tasks", failed_in_batch));
                if !failed_by_type.is_empty() {
                    log_parts.push(format!("({})", failed_by_type.join(", ")));
                }
            }
            info!("[SYNC] Sync completed: {}", log_parts.join(", "));
        }
        eprintln!(
            "[SYNC] Sync completed: {} sent, {} failed",
            synced_count, failed_in_batch
        );

        Ok(synced_count)
    }

    /// Синхронизировать очередь (обработать pending задачи)
    /// PRODUCTION: Single-flight через sync_lock с таймаутом
    pub async fn sync_queue(&self, max_retries: i32) -> Result<usize, String> {
        match tokio::time::timeout(tokio::time::Duration::from_secs(300), self.sync_lock.lock())
            .await
        {
            Ok(lock) => {
                let _lock = lock;
                self.run_sync_internal(max_retries)
                    .await
                    .map_err(|e| e.to_string())
            }
            Err(_) => {
                error!("[SYNC] CRITICAL: Sync lock timeout (300s) - previous sync may be stuck");
                Err(
                    "Sync lock timeout: previous sync may be stuck. Check logs for stuck sync task."
                        .to_string(),
                )
            }
        }
    }
}
