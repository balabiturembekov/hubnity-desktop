use crate::auth::AuthManager;
use crate::models::TokenRefreshResult;
use crate::Database;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

/// Приоритет задачи синхронизации
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
    // GUARD: Single-flight sync lock (только tokio::Mutex, без AtomicBool)
    pub(crate) sync_lock: Arc<tokio::sync::Mutex<()>>,
}

impl SyncManager {
    pub fn new(db: Arc<Database>) -> Self {
        let api_base_url = "https://app.automatonsoft.de/api".to_string();
        Self {
            db,
            api_base_url: api_base_url.clone(),
            auth_manager: Arc::new(AuthManager::new(api_base_url)),
            sync_lock: Arc::new(tokio::sync::Mutex::new(())),
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

    /// Обновить токен через refresh token
    /// Используется в тестах и через auth_manager.refresh_token() в sync_task
    #[allow(dead_code)] // Используется в тестах
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<TokenRefreshResult, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let url = format!("{}/auth/refresh", self.api_base_url);
        let response = client
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
    pub fn enqueue_time_entry(
        &self,
        operation: &str,
        payload: serde_json::Value,
        _access_token: String, // Не используется - оставлен для обратной совместимости
        _refresh_token: Option<String>, // Не используется - оставлен для обратной совместимости
    ) -> Result<i64, String> {
        // PRODUCTION: Токены НЕ сохраняются в payload
        // Они будут получаться через AuthManager.get_fresh_token() при синхронизации
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
    ) -> Result<bool, String> {
        let payload_json: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|e| format!("Failed to parse payload: {}", e))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        // PRODUCTION: Получаем токены через AuthManager (не из payload)
        let mut access_token = self.auth_manager.get_access_token().await.map_err(|e| {
            format!(
                "Failed to get access token: {}. Call set_auth_tokens first.",
                e
            )
        })?;

        let mut refresh_token = self
            .auth_manager
            .get_refresh_token()
            .await
            .map_err(|e| format!("Failed to get refresh token: {}", e))?;

        // Выполняем запрос с возможностью обновления токена при 401
        let mut retry_with_refresh = true;
        loop {
            // Выполняем HTTP запрос
            let response_result = if entity_type.starts_with("time_entry_") {
                let operation = entity_type.strip_prefix("time_entry_").unwrap();

                // PRODUCTION: Payload уже не содержит токенов
                let request_payload = payload_json.clone();

                let url = match operation {
                    "start" => format!("{}/time-entries", self.api_base_url),
                    "pause" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for pause operation".to_string())?;
                        format!("{}/time-entries/{}/pause", self.api_base_url, id)
                    }
                    "resume" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for resume operation".to_string())?;
                        format!("{}/time-entries/{}/resume", self.api_base_url, id)
                    }
                    "stop" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for stop operation".to_string())?;
                        format!("{}/time-entries/{}/stop", self.api_base_url, id)
                    }
                    _ => return Err(format!("Unknown time entry operation: {}", operation)),
                };

                let method = match operation {
                    "start" => client.post(&url),
                    "pause" | "resume" | "stop" => client.put(&url),
                    _ => return Err(format!("Unknown operation: {}", operation)),
                };

                let mut request = method
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {}", access_token));

                // CRITICAL FIX: Добавляем idempotency key в заголовок
                // ДОКАЗАНО: Сервер может использовать этот ключ для дедупликации
                if let Some(ref key) = idempotency_key {
                    request = request.header("X-Idempotency-Key", key);
                }

                request.json(&request_payload).send().await
            } else if entity_type == "screenshot" {
                let image_data = payload_json["imageData"]
                    .as_str()
                    .ok_or_else(|| "Missing imageData in payload".to_string())?;
                let time_entry_id = payload_json["timeEntryId"]
                    .as_str()
                    .ok_or_else(|| "Missing timeEntryId in payload".to_string())?;

                let screenshot_payload = serde_json::json!({
                    "imageData": image_data,
                    "timeEntryId": time_entry_id,
                });

                let url = format!("{}/screenshots", self.api_base_url);
                let mut request = client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {}", access_token));

                // CRITICAL FIX: Добавляем idempotency key в заголовок
                if let Some(ref key) = idempotency_key {
                    request = request.header("X-Idempotency-Key", key);
                }

                request.json(&screenshot_payload).send().await
            } else {
                return Err(format!("Unknown entity type: {}", entity_type));
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
                                    let error_msg = format!("Token refresh failed: {}", e);
                                    warn!(
                                        "[SYNC] Failed to refresh token for task {}: {}",
                                        task_id, error_msg
                                    );
                                    return Err(error_msg); // Возвращаем ошибку для сохранения в БД
                                }
                            }
                        } else {
                            let error_msg =
                                "Token expired (401) but no refresh token available".to_string();
                            warn!("[SYNC] {} for task {}", error_msg, task_id);
                            return Err(error_msg); // Возвращаем ошибку для сохранения в БД
                        }
                    }

                    // Возвращаем результат
                    let status_code = status.as_u16();
                    if status.is_success() {
                        return Ok(true);
                    } else {
                        // Сохраняем статус код в ошибке
                        let error_msg = format!(
                            "HTTP {}: {}",
                            status_code,
                            status.canonical_reason().unwrap_or("Unknown")
                        );
                        return Err(error_msg);
                    }
                }
                Err(e) => {
                    // Ошибка сети - возвращаем ошибку для retry
                    return Err(format!("Network error: {}", e));
                }
            }
        }
    }

    /// Внутренний метод синхронизации (single-flight)
    /// PRODUCTION: Все точки входа сходятся здесь
    async fn run_sync_internal(&self, max_retries: i32) -> Result<usize, String> {
        // PRODUCTION: Проверяем наличие токенов перед синхронизацией
        // Если токенов нет, пропускаем синхронизацию (токены могут быть еще не установлены при старте)
        if self.auth_manager.get_access_token().await.is_err() {
            warn!("[SYNC] Skipping sync: access token not set. Tokens may not be restored yet.");
            return Ok(0); // Возвращаем 0, не ошибку - это нормальная ситуация при старте
        }

        // Получаем количество pending задач для адаптивного batch
        let pending_count = self
            .db
            .get_pending_count_for_batch()
            .map_err(|e| format!("Failed to get pending count: {}", e))?;

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

        // Получаем задачи с приоритетами и exponential backoff
        let tasks = self
            .db
            .get_retry_tasks(max_retries, batch_size)
            .map_err(|e| format!("Failed to get retry tasks: {}", e))?;

        if tasks.is_empty() {
            debug!(
                "[SYNC] No tasks ready for retry (exponential backoff or all tasks processed), skipping batch"
            );
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
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        // Обновляем статус на pending с новым retry_count
                        // next_retry_at будет вычислен при следующем get_retry_tasks
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        info!(
                            "[SYNC] Task {} will retry later (attempt {})",
                            id, new_retry_count
                        );
                    }
                }
                Err(e) => {
                    // Ошибка сети или другая ошибка
                    failed_in_batch += 1;
                    *by_type_failed.entry(entity_type.clone()).or_insert(0) += 1;
                    let new_retry_count = retry_count + 1;
                    let error_msg = format!("{}", e);
                    if new_retry_count >= max_retries {
                        self.db
                            .update_sync_status_with_error(
                                id,
                                "failed",
                                new_retry_count,
                                Some(&error_msg),
                            )
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        // Обновляем статус на pending с новым retry_count
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|e| format!("Failed to update status: {}", e))?;
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

        Ok(synced_count)
    }

    /// Синхронизировать очередь (обработать pending задачи)
    /// PRODUCTION: Single-flight через sync_lock с таймаутом
    pub async fn sync_queue(&self, max_retries: i32) -> Result<usize, String> {
        // GUARD: Single-flight - только один sync может выполняться одновременно
        // GUARD: Таймаут для lock (300 сек) - защита от зависания предыдущего sync
        match tokio::time::timeout(tokio::time::Duration::from_secs(300), self.sync_lock.lock())
            .await
        {
            Ok(lock) => {
                let _lock = lock;
                self.run_sync_internal(max_retries).await
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
