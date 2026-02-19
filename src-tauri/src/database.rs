use rusqlite::{params, Connection, Result as SqliteResult};
use std::sync::{Arc, Mutex};
use tracing::{error, warn};

use crate::auth::TokenEncryption;

/// Log IO-related DB errors for easier diagnosis (disk full, permission denied).
/// Does not change error propagation — caller still returns Err.
fn log_io_error_if_any(context: &str, e: &rusqlite::Error) {
    use rusqlite::ffi::ErrorCode;
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = e {
        match ffi_err.code {
            ErrorCode::DiskFull => {
                error!(
                    "[DB] {}: Disk full. Free space on drive or check app data directory.",
                    context
                );
            }
            ErrorCode::ReadOnly | ErrorCode::CannotOpen => {
                error!(
                    "[DB] {}: Permission denied or read-only. Check app data directory is writable.",
                    context
                );
            }
            ErrorCode::SystemIoFailure => {
                error!(
                    "[DB] {}: I/O error. Check disk and permissions.",
                    context
                );
            }
            _ => {}
        }
    }
}

/// Convert rusqlite errors from enqueue_sync to user-friendly messages for frontend.
/// CHAOS AUDIT: Ensures disk full / read-only errors surface as "Data sync unavailable (Disk Full?)".
pub fn enqueue_error_to_user_message(e: &rusqlite::Error) -> String {
    use rusqlite::ffi::ErrorCode;
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = e {
        match ffi_err.code {
            ErrorCode::DiskFull => "Data sync unavailable (Disk Full?)".to_string(),
            ErrorCode::ReadOnly | ErrorCode::CannotOpen => {
                "Data sync unavailable (Permission denied?)".to_string()
            }
            ErrorCode::SystemIoFailure => "Data sync unavailable (I/O error?)".to_string(),
            _ => format!("Failed to enqueue: {}", e),
        }
    } else {
        format!("Failed to enqueue: {}", e)
    }
}

use crate::models::{FailedTaskInfo, QueueStats};
use crate::sync::TaskPriority;
use chrono::Utc;
use rusqlite::Error::InvalidParameterName;
use std::collections::hash_map::DefaultHasher;

use std::hash::{Hash, Hasher};
/// Менеджер базы данных
pub struct Database {
    pub(crate) conn: Arc<Mutex<Connection>>,
    pub(crate) encryption: Arc<TokenEncryption>,
}

impl Database {
    /// Безопасная блокировка соединения с обработкой poisoned mutex
    /// PRODUCTION: Обрабатывает случай, когда mutex был poisoned (panic в другом потоке)
    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, rusqlite::Error> {
        self.conn.lock().map_err(|e| {
            InvalidParameterName(format!(
                "Database mutex poisoned: {}. A panic occurred while holding the lock. \
                 Please restart the application to recover.",
                e
            ))
        })
    }

    pub fn new(db_path: &str) -> SqliteResult<Self> {
        // pragma_update требует &mut self, поэтому нужен mut
        #[allow(unused_mut)]
        let mut conn = Connection::open(db_path)?;

        // GUARD: Integrity check on startup — detect corruption before init
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| InvalidParameterName(format!("Integrity check failed: {}", e)))?;
        if integrity.to_lowercase() != "ok" {
            return Err(InvalidParameterName(format!(
                "Database corruption detected: {}",
                integrity
            )));
        }

        // GUARD: Включаем WAL mode для лучшей производительности и безопасности
        // WAL (Write-Ahead Logging) обеспечивает лучшую защиту от corruption
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| {
                warn!(
                    "[DB] Failed to enable WAL mode: {}. Continuing with default journal mode.",
                    e
                );
                // Не критично - продолжаем с дефолтным режимом
            })
            .ok();

        // PERFORMANCE: Reduce disk I/O during sync bursts (safe with WAL)
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        // 64MB cache (negative = KB) — fewer disk reads
        let _ = conn.pragma_update(None, "cache_size", "-64000");
        // Temp tables in RAM
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");

        // GUARD: Включаем foreign_keys для целостности данных
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| {
                warn!("[DB] Failed to enable foreign keys: {}. Continuing.", e);
            })
            .ok();

        let app_data_dir = std::path::Path::new(db_path).parent();
        let encryption = TokenEncryption::new(app_data_dir).map_err(|e| InvalidParameterName(e))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            encryption: Arc::new(encryption),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Current schema version (PRAGMA user_version). Bump when adding migrations.
    const SCHEMA_VERSION: i32 = 5;

    /// Versioned migrations using SQLite user_version pragma.
    /// When releasing v0.2.0 with new columns (e.g. task_category), add migration 6 and bump SCHEMA_VERSION.
    fn run_migrations(&self) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        let current: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        if current < 1 {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS time_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL,
                accumulated_seconds INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                last_updated_at INTEGER NOT NULL,
                started_at INTEGER,
                UNIQUE(day)
            )",
                [],
            )?;
            conn.execute(
                "CREATE TABLE IF NOT EXISTS sync_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_retry_at INTEGER,
                error_message TEXT,
                priority INTEGER NOT NULL DEFAULT 2,
                idempotency_key TEXT
            )",
                [],
            )?;
            conn.execute(
                "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)",
                [],
            )?;
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)",
                [],
            )?;
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_time_entries_day ON time_entries(day)",
                [],
            )?;
        }

        // Migration 2: error_message (idempotent ALTER)
        if current < 2 {
            let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN error_message TEXT", []);
        }
        // Migration 3: priority
        if current < 3 {
            let _ = conn.execute(
                "ALTER TABLE sync_queue ADD COLUMN priority INTEGER DEFAULT 2",
                [],
            );
        }
        // Migration 4: started_at
        if current < 4 {
            let _ = conn.execute("ALTER TABLE time_entries ADD COLUMN started_at INTEGER", []);
        }
        // Migration 5: idempotency_key
        if current < 5 {
            let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN idempotency_key TEXT", []);
        }

        // Future: Migration 6 (v0.2.0): task_category
        // if current < 6 {
        //     let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN task_category TEXT", []);
        // }

        conn.pragma_update(None, "user_version", Self::SCHEMA_VERSION)?;
        Ok(())
    }

    /// Сохранить состояние таймера
    /// GUARD: Использует транзакцию для атомарности (защита от partial writes)
    pub fn save_timer_state(
        &self,
        day: &str,
        accumulated_seconds: u64,
        state: &str,
        started_at: Option<u64>,
    ) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // GUARD: Начинаем транзакцию для атомарности
        // BEGIN IMMEDIATE гарантирует, что транзакция начнется немедленно
        // и не будет ждать освобождения блокировки
        conn.execute("BEGIN IMMEDIATE TRANSACTION", [])
            .map_err(|e| {
                log_io_error_if_any("save_timer_state begin", &e);
                error!("[DB] Failed to begin transaction: {}", e);
                e
            })?;

        // Выполняем операцию внутри транзакции
        let result = conn.execute(
            "INSERT INTO time_entries (day, accumulated_seconds, state, last_updated_at, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(day) DO UPDATE SET
        accumulated_seconds = ?2,
        state = ?3,
        last_updated_at = ?4,
        started_at = ?5",
            params![day, accumulated_seconds, state, now, started_at],
        );

        // GUARD: Коммитим или откатываем транзакцию
        match result {
            Ok(_) => {
                // Успешно - коммитим транзакцию
                conn.execute("COMMIT", []).map_err(|e| {
                    log_io_error_if_any("save_timer_state commit", &e);
                    error!("[DB] Failed to commit transaction: {}", e);
                    // Пытаемся откатить
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                // CLOCK SKEW: Store wall time for restore_state cap (protects against forward skew)
                let _ = conn.execute(
                    "INSERT INTO app_meta (key, value) VALUES ('last_heartbeat_wall_secs', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
                    params![now.to_string()],
                );
                Ok(())
            }
            Err(e) => {
                log_io_error_if_any("save_timer_state", &e);
                error!(
                    "[DB] Failed to save timer state: {}. Rolling back transaction.",
                    e
                );
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Загрузить последнее состояние таймера
    pub fn load_timer_state(&self) -> SqliteResult<Option<(String, u64, String, Option<u64>)>> {
        let conn = self.lock_conn()?;

        let mut stmt = conn.prepare(
            "SELECT day, accumulated_seconds, state, started_at FROM time_entries
     ORDER BY last_updated_at DESC LIMIT 1",
        )?;

        let result = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
            ))
        })?;

        for row in result {
            return Ok(Some(row?));
        }

        Ok(None)
    }

    /// Получить последний time entry ID из очереди (pending или sent) — fallback когда app_meta пуст
    pub fn get_last_time_entry_id_from_queue(&self) -> SqliteResult<Option<String>> {
        let raw_rows: Vec<(i64, String, String)> = {
            let conn = self.lock_conn()?;
            let mut stmt = conn.prepare(
                "SELECT id, entity_type, payload FROM sync_queue
                 WHERE entity_type IN ('time_entry_pause', 'time_entry_resume', 'time_entry_stop')
                 ORDER BY created_at DESC LIMIT 5",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        for (row_id, _entity_type, encrypted) in raw_rows {
            if let Ok((decrypted, needs_migration)) =
                self.encryption.decrypt_with_legacy_fallback(&encrypted)
            {
                if needs_migration {
                    if let Ok(new_encrypted) = self.encryption.encrypt(&decrypted) {
                        let _ = self.update_sync_payload(row_id, &new_encrypted);
                    }
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&decrypted) {
                    if let Some(id) = v.get("id").and_then(|v| v.as_str()) {
                        if !id.is_empty() && !id.starts_with("temp-") {
                            return Ok(Some(id.to_string()));
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    /// Получить значение из app_meta (для изоляции данных по пользователю)
    pub fn get_app_meta(&self, key: &str) -> SqliteResult<Option<String>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT value FROM app_meta WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(row.get(0)?));
        }
        Ok(None)
    }

    /// Записать значение в app_meta
    pub fn set_app_meta(&self, key: &str, value: &str) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    /// Очистить локальные данные (таймер, очередь синхронизации).
    /// Вызывать только при реальной смене пользователя (A → B), не при входе после логаута ("" → A).
    pub fn clear_user_data(&self) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute("DELETE FROM time_entries", [])?;
        conn.execute("DELETE FROM sync_queue", [])?;
        let _ = self.set_app_meta("last_active_time_entry_id", "");
        Ok(())
    }

    /// Добавить задачу в очередь синхронизации
    /// Защита от дублирования: не добавляет задачу, если такая же задача уже в очереди (pending) за последние 5 секунд
    /// CRITICAL FIX: Использует явную транзакцию для атомарности
    pub fn enqueue_sync(&self, entity_type: &str, payload: &str) -> SqliteResult<i64> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();
        let duplicate_window = 5; // 5 секунд

        // CRITICAL FIX: Генерируем idempotency key из entity_type + payload
        // ДОКАЗАНО: Одинаковые entity_type + payload дают одинаковый ключ
        let mut hasher = DefaultHasher::new();
        entity_type.hash(&mut hasher);
        payload.hash(&mut hasher);
        let idempotency_key = format!("{}-{:x}", entity_type, hasher.finish());

        let encrypted_payload = self.encryption.encrypt(payload).map_err(|e| {
            error!("[DB] Encryption failed for payload: {}", e);
            InvalidParameterName(format!("Encryption error: {}", e))
        })?;

        // CRITICAL FIX: Начинаем явную транзакцию для атомарности
        // BEGIN IMMEDIATE гарантирует, что транзакция начнется немедленно
        conn.execute("BEGIN IMMEDIATE TRANSACTION", [])
            .map_err(|e| {
                error!("[DB] Failed to begin transaction in enqueue_sync: {}", e);
                e
            })?;

        // Проверяем, есть ли такая же задача в очереди (pending) за последние 5 секунд
        let duplicate_check: i32 = match conn.query_row(
            "SELECT COUNT(*) FROM sync_queue 
             WHERE idempotency_key = ?1 
             AND status = 'pending' 
             AND created_at > ?2",
            params![idempotency_key, now - duplicate_window],
            |row| row.get(0),
        ) {
            Ok(count) => count,
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        };

        if duplicate_check > 0 {
            // Такая же задача уже в очереди - не добавляем дубликат
            warn!(
                "[DB] Duplicate task detected: {} with payload {} (skipping)",
                entity_type,
                if payload.len() > 50 {
                    &payload[..50]
                } else {
                    payload
                }
            );
            // Возвращаем ID существующей задачи по idempotency_key (payload в БД зашифрован)
            let existing_id: i64 = match conn.query_row(
                "SELECT id FROM sync_queue 
                 WHERE idempotency_key = ?1 
                 AND status = 'pending' 
                 AND created_at > ?2
                 ORDER BY created_at DESC 
                 LIMIT 1",
                params![idempotency_key, now - duplicate_window],
                |row| row.get(0),
            ) {
                Ok(id) => {
                    // ДОКАЗАНО: Дубликат найден - коммитим транзакцию и возвращаем ID
                    conn.execute("COMMIT", []).map_err(|e| {
                        error!(
                            "[DB] Failed to commit transaction in enqueue_sync (duplicate): {}",
                            e
                        );
                        let _ = conn.execute("ROLLBACK", []);
                        e
                    })?;
                    id
                }
                Err(e) => {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(e);
                }
            };
            return Ok(existing_id);
        }

        // Определяем приоритет задачи
        let priority = TaskPriority::from_entity_type(entity_type);
        let priority_value = priority as i32;

        // GUARD: Проверка лимита очереди (10_000 задач)
        let queue_size: i32 = match conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'failed')",
            [],
            |row| row.get(0),
        ) {
            Ok(size) => size,
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        };

        if queue_size >= 10_000 {
            // Очередь переполнена - не добавляем новые задачи (кроме critical)
            if priority != TaskPriority::Critical {
                warn!(
                    "[DB] Queue limit reached ({} tasks), dropping non-critical task: {}",
                    queue_size, entity_type
                );
                let _ = conn.execute("ROLLBACK", []);
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
                    Some("Queue limit reached".to_string()),
                ));
            }
            // Для critical задач удаляем самые старые normal задачи
            let _ = conn.execute(
                "DELETE FROM sync_queue 
                 WHERE status = 'pending' 
                 AND priority = 2 
                 AND id IN (
                     SELECT id FROM sync_queue 
                     WHERE status = 'pending' AND priority = 2 
                     ORDER BY created_at ASC 
                     LIMIT 10
                 )",
                [],
            );
        }

        // CRITICAL FIX: INSERT внутри транзакции с idempotency_key
        let result = conn.execute(
            "INSERT INTO sync_queue (entity_type, payload, status, created_at, priority, idempotency_key)
     VALUES (?1, ?2, 'pending', ?3, ?4, ?5)",
            params![entity_type, encrypted_payload, now, priority_value, idempotency_key],
        );

        // CRITICAL FIX: Коммитим или откатываем транзакцию
        match result {
            Ok(_) => {
                // ДОКАЗАНО: INSERT успешен - коммитим транзакцию
                conn.execute("COMMIT", []).map_err(|e| {
                    log_io_error_if_any("enqueue_sync commit", &e);
                    error!("[DB] Failed to commit transaction in enqueue_sync: {}", e);
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                Ok(conn.last_insert_rowid())
            }
            Err(e) => {
                log_io_error_if_any("enqueue_sync", &e);
                error!(
                    "[DB] Failed to insert task in enqueue_sync: {}. Rolling back transaction.",
                    e
                );
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Получить количество pending задач (для адаптивного batch)
    pub fn get_pending_count_for_batch(&self) -> SqliteResult<i32> {
        self.get_pending_count()
    }

    /// Получить задачи для синхронизации (для тестов)
    #[cfg(test)]
    pub(crate) fn get_pending_sync_tasks(
        &self,
        limit: i32,
    ) -> SqliteResult<Vec<(i64, String, String)>> {
        let conn = self.lock_conn()?;

        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload FROM sync_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }

    /// Обновить статус задачи синхронизации
    pub fn update_sync_status(&self, id: i64, status: &str, retry_count: i32) -> SqliteResult<()> {
        self.update_sync_status_with_error(id, status, retry_count, None)
    }

    /// Обновить статус задачи синхронизации с причиной ошибки
    pub fn update_sync_status_with_error(
        &self,
        id: i64,
        status: &str,
        retry_count: i32,
        error_message: Option<&str>,
    ) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        if let Some(error) = error_message {
            conn.execute(
                "UPDATE sync_queue 
         SET status = ?1, retry_count = ?2, last_retry_at = ?3, error_message = ?4
         WHERE id = ?5",
                params![status, retry_count, now, error, id],
            )?;
        } else {
            conn.execute(
                "UPDATE sync_queue 
         SET status = ?1, retry_count = ?2, last_retry_at = ?3
         WHERE id = ?4",
                params![status, retry_count, now, id],
            )?;
        }

        Ok(())
    }

    /// Получить количество pending задач
    pub fn get_pending_count(&self) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Получить количество failed задач
    pub fn get_failed_count(&self) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Получить статистику очереди по типам задач
    pub fn get_queue_stats(&self) -> SqliteResult<QueueStats> {
        let conn = self.lock_conn()?;

        // Статистика по типам задач для pending
        let mut stmt = conn.prepare(
            "SELECT entity_type, COUNT(*) as count 
             FROM sync_queue 
             WHERE status = 'pending' 
             GROUP BY entity_type",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
        })?;

        let mut by_type: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
        for row in rows {
            let (entity_type, count) = row?;
            by_type.insert(entity_type, count);
        }

        // Общее количество pending
        let pending_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;

        // Общее количество failed
        let failed_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;

        // Общее количество sent (успешно синхронизированных)
        let sent_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'sent'",
            [],
            |row| row.get(0),
        )?;

        Ok(QueueStats {
            pending_count,
            failed_count,
            sent_count,
            pending_by_type: by_type,
        })
    }

    /// Обновить payload задачи (для миграции ключа шифрования)
    pub fn update_sync_payload(&self, id: i64, encrypted_payload: &str) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE sync_queue SET payload = ?1 WHERE id = ?2",
            params![encrypted_payload, id],
        )?;
        Ok(())
    }

    /// Обновить статус задачи на "sent" (успешная синхронизация)
    /// PRODUCTION: Partial success - успешные задачи помечаются сразу
    pub fn mark_task_sent(&self, id: i64) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE sync_queue SET status = 'sent' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Зарезервировать задачи для текущего sync run (обновить last_retry_at)
    /// Предотвращает повторный выбор тех же задач другим sync в течение backoff окна
    pub fn claim_tasks_for_sync(&self, ids: &[i64]) -> SqliteResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();
        for id in ids {
            conn.execute(
                "UPDATE sync_queue SET last_retry_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
        Ok(())
    }

    /// Получить список failed задач с деталями
    pub fn get_failed_tasks(&self, limit: i32) -> SqliteResult<Vec<FailedTaskInfo>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload, retry_count, created_at, last_retry_at, error_message 
             FROM sync_queue 
             WHERE status = 'failed' 
             ORDER BY created_at DESC 
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(FailedTaskInfo {
                id: row.get::<_, i64>(0)?,
                entity_type: row.get::<_, String>(1)?,
                payload: row.get::<_, String>(2)?,
                retry_count: row.get::<_, i32>(3)?,
                created_at: row.get::<_, i64>(4)?,
                last_retry_at: row.get::<_, Option<i64>>(5)?,
                error_message: row.get::<_, Option<String>>(6)?,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }

    /// Отменить противоположные операции для time entry (resume <-> pause)
    /// Отменяет pending задачи противоположного типа за последние 30 секунд
    /// NOTE: time_entry_id параметр зарезервирован для будущей более точной фильтрации
    pub fn cancel_opposite_time_entry_operations(
        &self,
        operation: &str,
        _time_entry_id: &str,
    ) -> SqliteResult<usize> {
        let conn = self.lock_conn()?;

        // Определяем противоположную операцию
        let opposite_operation = match operation {
            "resume" => "pause",
            "pause" => "resume",
            _ => return Ok(0), // Для других операций нет противоположных
        };

        let opposite_entity_type = format!("time_entry_{}", opposite_operation);

        // Ищем pending задачи противоположного типа с тем же timeEntryId в payload
        // Payload зашифрован, но мы можем искать по частичному совпадению после расшифровки
        // Или проще - искать все pending задачи противоположного типа и проверять payload
        // Но для простоты ищем все pending задачи противоположного типа
        // и отменяем их (они будут обработаны как "state-already-achieved" при синхронизации)

        // Более точный подход: ищем задачи с противоположным типом и проверяем payload
        // Но payload зашифрован, поэтому просто отменяем все pending задачи противоположного типа
        // Это безопасно, так как при синхронизации они будут обработаны корректно

        // ВАЖНО: Отменяем только недавние задачи (за последние 30 секунд), чтобы не отменить старые
        let now = Utc::now().timestamp();
        let recent_window = 30; // 30 секунд

        let count = conn.execute(
            "UPDATE sync_queue 
             SET status = 'cancelled' 
             WHERE entity_type = ?1 
             AND status = 'pending' 
             AND created_at > ?2",
            params![opposite_entity_type, now - recent_window],
        )?;

        if count > 0 {
            warn!(
                "[DB] Cancelled {} opposite {} operations (recent {}s)",
                count, opposite_operation, recent_window
            );
        }

        Ok(count as usize)
    }

    /// Очистить всю очередь синхронизации (safety valve для пользователей)
    pub fn clear_sync_queue(&self) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute("DELETE FROM sync_queue", [])?;
        Ok(())
    }

    /// Сбросить failed задачи обратно в pending для повторной попытки
    pub fn reset_failed_tasks(&self, limit: i32) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // Сбрасываем retry_count в 0 и статус в 'pending' для failed задач
        let count = conn.execute(
            "UPDATE sync_queue 
             SET status = 'pending', retry_count = 0, last_retry_at = ?1
             WHERE status = 'failed' 
             AND id IN (
                 SELECT id FROM sync_queue 
                 WHERE status = 'failed' 
                 ORDER BY created_at ASC 
                 LIMIT ?2
             )",
            params![now, limit],
        )?;

        Ok(count as i32)
    }

    /// Получить задачи для повторной попытки (exponential backoff)
    /// Получить задачи для синхронизации с адаптивным batch size и приоритетами
    /// PRODUCTION: Exponential backoff: 10 сек → 20 сек → 40 сек → 80 сек → 120 сек (max)
    /// CRITICAL FIX: aggressive_retry=true — при восстановлении сети используем 5 сек вместо полного backoff
    pub fn get_retry_tasks(
        &self,
        max_retries: i32,
        batch_size: i32,
        aggressive_retry: bool,
    ) -> SqliteResult<Vec<(i64, String, String, i32, Option<String>)>> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // aggressive_retry: при online — 5 сек, чтобы сразу повторить после восстановления сети
        let backoff_sql = if aggressive_retry {
            "5"
        } else {
            "CASE 
              WHEN retry_count = 0 THEN 10
              WHEN retry_count = 1 THEN 20
              WHEN retry_count = 2 THEN 40
              WHEN retry_count = 3 THEN 80
              WHEN retry_count >= 4 THEN 120
              ELSE 120
          END"
        };

        let sql = format!(
            "SELECT id, entity_type, payload, retry_count, idempotency_key FROM sync_queue
     WHERE status = 'pending' AND retry_count < ?1
     AND (last_retry_at IS NULL OR last_retry_at + {} <= ?2)
     ORDER BY priority ASC, created_at ASC
     LIMIT ?3",
            backoff_sql
        );

        let mut stmt = conn.prepare(&sql)?;

        let raw_rows: Vec<(i64, String, String, i32, Option<String>)> = stmt
            .query_map(params![max_retries, now, batch_size], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        drop(stmt);
        drop(conn);

        let mut result = Vec::new();
        for (id, entity_type, encrypted_payload, retry_count, idempotency_key) in raw_rows {
            match self
                .encryption
                .decrypt_with_legacy_fallback(&encrypted_payload)
            {
                Ok((payload, needs_migration)) => {
                    if needs_migration {
                        if let Ok(new_encrypted) = self.encryption.encrypt(&payload) {
                            if self.update_sync_payload(id, &new_encrypted).is_ok() {
                                tracing::warn!(
                                    "[DB] Migration successful: task {} re-encrypted with new key",
                                    id
                                );
                            }
                        }
                    }
                    result.push((id, entity_type, payload, retry_count, idempotency_key));
                }
                Err(e) => {
                    warn!(
                        "[DB] Skipping task {}: decryption failed ({}). One broken task won't block the queue.",
                        id, e
                    );
                }
            }
        }

        Ok(result)
    }
}
