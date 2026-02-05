use rusqlite::{params, Connection, Result as SqliteResult};
use std::sync::{Arc, Mutex};
use tracing::{error, warn};

use crate::models::{FailedTaskInfo, QueueStats};
use crate::TaskPriority;
use chrono::Utc;
use std::collections::hash_map::DefaultHasher;

use std::hash::{Hash, Hasher};
/// Менеджер базы данных
pub struct Database {
    pub(crate) conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Безопасная блокировка соединения с обработкой poisoned mutex
    /// PRODUCTION: Обрабатывает случай, когда mutex был poisoned (panic в другом потоке)
    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, rusqlite::Error> {
        self.conn.lock().map_err(|e| {
            rusqlite::Error::InvalidParameterName(format!(
                "Database mutex poisoned: {}. This indicates a panic occurred while holding the lock.",
                e
            ))
        })
    }

    pub fn new(db_path: &str) -> SqliteResult<Self> {
        // pragma_update требует &mut self, поэтому нужен mut
        #[allow(unused_mut)]
        let mut conn = Connection::open(db_path)?;

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

        // GUARD: Включаем foreign_keys для целостности данных
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| {
                warn!("[DB] Failed to enable foreign keys: {}. Continuing.", e);
            })
            .ok();

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_schema()?;
        Ok(db)
    }

    /// Инициализация схемы БД
    fn init_schema(&self) -> SqliteResult<()> {
        let conn = self.lock_conn()?;

        // Таблица для сохранения состояния таймера
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

        // Таблица очереди синхронизации
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

        // Миграции: добавляем колонки если их нет
        let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN error_message TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE sync_queue ADD COLUMN priority INTEGER DEFAULT 2",
            [],
        );
        // Миграция: добавляем started_at для восстановления времени при перезапуске
        let _ = conn.execute("ALTER TABLE time_entries ADD COLUMN started_at INTEGER", []);
        // CRITICAL FIX: Миграция для idempotency keys
        let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN idempotency_key TEXT", []);

        // Индексы для быстрого поиска
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_time_entries_day ON time_entries(day)",
            [],
        )?;

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
                    error!("[DB] Failed to commit transaction: {}", e);
                    // Пытаемся откатить
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                Ok(())
            }
            Err(e) => {
                // Ошибка - откатываем транзакцию
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
             WHERE entity_type = ?1 
             AND payload = ?2 
             AND status = 'pending' 
             AND created_at > ?3",
            params![entity_type, payload, now - duplicate_window],
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
            // Возвращаем ID существующей задачи (находим её)
            let existing_id: i64 = match conn.query_row(
                "SELECT id FROM sync_queue 
                 WHERE entity_type = ?1 
                 AND payload = ?2 
                 AND status = 'pending' 
                 AND created_at > ?3
                 ORDER BY created_at DESC 
                 LIMIT 1",
                params![entity_type, payload, now - duplicate_window],
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
            params![entity_type, payload, now, priority_value, idempotency_key],
        );

        // CRITICAL FIX: Коммитим или откатываем транзакцию
        match result {
            Ok(_) => {
                // ДОКАЗАНО: INSERT успешен - коммитим транзакцию
                conn.execute("COMMIT", []).map_err(|e| {
                    error!("[DB] Failed to commit transaction in enqueue_sync: {}", e);
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                Ok(conn.last_insert_rowid())
            }
            Err(e) => {
                // ДОКАЗАНО: INSERT не удался - откатываем транзакцию
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
    /// CRITICAL FIX: Возвращает idempotency_key для предотвращения дубликатов
    pub fn get_retry_tasks(
        &self,
        max_retries: i32,
        batch_size: i32,
    ) -> SqliteResult<Vec<(i64, String, String, i32, Option<String>)>> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // PRODUCTION: Исправленный exponential backoff
        // Минимум: 10 секунд, максимум: 120 секунд (2 минуты)
        // Формула: min(10 * 2^retry_count, 120)
        // CRITICAL FIX: Включаем idempotency_key в SELECT
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload, retry_count, idempotency_key FROM sync_queue
     WHERE status = 'pending' AND retry_count < ?1
     AND (last_retry_at IS NULL OR 
          last_retry_at + CASE 
              WHEN retry_count = 0 THEN 10
              WHEN retry_count = 1 THEN 20
              WHEN retry_count = 2 THEN 40
              WHEN retry_count = 3 THEN 80
              WHEN retry_count >= 4 THEN 120
              ELSE 120
          END <= ?2)
     ORDER BY priority ASC, created_at ASC
     LIMIT ?3",
        )?;

        let rows = stmt.query_map(params![max_retries, now, batch_size], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }
}
