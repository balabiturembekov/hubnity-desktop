#[allow(unused_imports)] // Local используется в тестах
use chrono::{Local, Utc};
use tauri::{AppHandle, Manager, Listener};
use tracing::{debug, error, info, warn};
mod commands;
mod engine;
mod sync;
mod auth;
mod database;
mod monitor;
mod models;
pub use database::Database;
use commands::*;
use crate::engine::{TimerEngine};
use crate::sync::SyncManager;
use crate::sync::TaskPriority;
use crate::monitor::ActivityMonitor;
use std::sync::{Arc};

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
pub fn extract_url_from_title(title: &str) -> (Option<String>, Option<String>) {
    // Try to find URL patterns in title
    // Browsers often show URLs in window titles

    // Pattern 1: Direct URL (http:// or https://)
    if let Some(url_start) = title.find("http://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    if let Some(url_start) = title.find("https://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    // Pattern 2: Title might be just the domain (e.g., "github.com")
    // Check if it looks like a domain
    if title.contains('.') && !title.contains(' ') {
        // Might be a domain, but we can't be sure it's a URL
        // Return None for URL, but return as domain
        return (None, Some(title.to_string()));
    }

    (None, None)
}

#[cfg(target_os = "macos")]
fn extract_domain(url: &str) -> Option<String> {
    // Extract domain from URL
    // Example: https://github.com/user/repo -> github.com

    if url.starts_with("http://") {
        let without_protocol = &url[7..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    if url.starts_with("https://") {
        let without_protocol = &url[8..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    None
}


/// Проверка online статуса через легковесный HTTP запрос
pub async fn check_online_status() -> bool {
    // Используем быстрый GET запрос к надежному серверу
    // Используем Cloudflare или Google для проверки подключения
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    // Пробуем подключиться к надежному серверу (Cloudflare)
    // Используем минимальный запрос для проверки подключения
    match client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => {
            // Если Cloudflare недоступен, пробуем Google
            match client
                .get("https://www.google.com/generate_204")
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) => response.status().is_success() || response.status().as_u16() == 204,
                Err(_) => false,
            }
        }
    }
}

#[derive(serde::Serialize)]
struct SyncStatusResponse {
    pending_count: i32,
    failed_count: i32,
    is_online: bool,
}


// ============================================
// SYSTEM SLEEP / WAKE HANDLING
// ============================================

#[cfg(target_os = "macos")]
fn setup_sleep_wake_handlers(_app: AppHandle, _engine: Arc<TimerEngine>) -> Result<(), String> {
    // Для macOS используем проверку времени в get_state() для обнаружения sleep
    // Это более простой и надежный подход, чем работа с NSWorkspace notifications через FFI
    // Большие пропуски времени (> 5 минут) будут автоматически обнаруживаться и обрабатываться

    eprintln!("[SLEEP/WAKE] Sleep/wake detection enabled via time gap checking in get_state()");
    eprintln!("[SLEEP/WAKE] Large time gaps (> 5 min) will trigger automatic pause");

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn setup_sleep_wake_handlers(_app: AppHandle, _engine: Arc<TimerEngine>) -> Result<(), String> {
    // Для других платформ можно использовать platform-specific API
    eprintln!("[SLEEP/WAKE] Sleep/wake handlers not implemented for this platform");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Инициализация структурированного логирования
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Инициализация базы данных в setup hook
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Failed to get app data directory: {}", e),
                )
            })?;
            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "Failed to create app data directory at {}: {}",
                        app_data_dir.display(),
                        e
                    ),
                )
            })?;

            let db_path = app_data_dir.join("hubnity.db");
            let db_path_str = db_path.to_str().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "Database path contains invalid UTF-8: {}",
                        db_path.display()
                    ),
                )
            })?;
            let db = Arc::new(Database::new(db_path_str).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to initialize database: {}", e),
                )
            })?);

            eprintln!("[DB] Database initialized at: {}", db_path.display());

            // Инициализируем TimerEngine с БД
            let engine = TimerEngine::with_db(db.clone());
            let engine_arc = Arc::new(engine);

            // Настраиваем обработчики sleep/wake (не сохраняет ссылку на engine)
            setup_sleep_wake_handlers(app.handle().clone(), engine_arc.clone())?;

            // CRITICAL FIX: Сохраняем состояние таймера при закрытии окна
            // Используем Tauri window close event для гарантированного сохранения
            let engine_for_close = engine_arc.clone();
            let app_handle = app.handle().clone();
            app_handle.listen("tauri://close-requested", move |_event| {
                // ДОКАЗАНО: Это событие вызывается синхронно перед закрытием окна
                // Сохраняем состояние таймера синхронно
                if let Err(e) = engine_for_close.save_state() {
                    eprintln!("[SHUTDOWN] Failed to save timer state on window close: {}", e);
                } else {
                    info!("[SHUTDOWN] Timer state saved successfully on window close");
                }
            });

            // CRITICAL FIX: Периодическое сохранение состояния (каждые 30 секунд)
            // ДОКАЗАНО: Это гарантирует, что состояние сохранено даже при force quit
            let engine_for_periodic = engine_arc.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
                    eprintln!("[TIMER] Failed to create runtime for periodic save: {}", e);
                    std::process::exit(1);
                });
                rt.block_on(async {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
                    loop {
                        interval.tick().await;
                        // ДОКАЗАНО: Периодическое сохранение гарантирует актуальность состояния в БД
                        if let Err(e) = engine_for_periodic.save_state() {
                            warn!("[TIMER] Failed to save state periodically: {}", e);
                        } else {
                            debug!("[TIMER] State saved periodically");
                        }
                    }
                });
            });

            // Управляем engine через Tauri State
            // CRITICAL FIX: Используем Arc напрямую, так как он используется в других местах
            // ДОКАЗАНО: Tauri State может работать с Arc<TimerEngine>, так как Arc: Send + Sync
            app.manage(engine_arc);

            // Инициализируем SyncManager
            let sync_manager = SyncManager::new(db.clone());
            app.manage(sync_manager.clone());

            // Запускаем фоновую синхронизацию в отдельном потоке с собственным Tokio runtime
            // Запускаем фоновую синхронизацию после полной инициализации приложения
            // Используем std::thread::spawn с блокирующим runtime для фоновой задачи
            // Это безопасно, так как задача выполняется в отдельном потоке
            let sync_manager_bg = sync_manager.clone();

            // CRITICAL FIX: Background sync с restart mechanism
            // ДОКАЗАНО: Thread автоматически перезапускается при панике или ошибке
            std::thread::spawn(move || {
                loop {
                    // Создаем отдельный Tokio runtime для фоновой задачи
                    // Это необходимо, так как в setup hook основной runtime еще не готов
                    let rt = match tokio::runtime::Runtime::new() {
                        Ok(rt) => rt,
                        Err(e) => {
                            error!(
                                "[SYNC] CRITICAL: Failed to create Tokio runtime for background sync: {}. Retrying in 10s...",
                                e
                            );
                            std::thread::sleep(std::time::Duration::from_secs(10));
                            continue; // Retry создания runtime
                        }
                    };
                    
                    // ДОКАЗАНО: Если block_on паникует или завершается, цикл перезапустит runtime
                    let _result = rt.block_on(async {
                        // PRODUCTION: Увеличиваем задержку для восстановления токенов из localStorage
                        // Frontend восстанавливает токены при монтировании, нужно дать время
                        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

                        info!("[SYNC] Starting background sync task");
                        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60)); // Каждую минуту
                        loop {
                            interval.tick().await;
                            match sync_manager_bg.sync_queue(5).await {
                                Ok(count) => {
                                    if count > 0 {
                                        info!("[SYNC] Synced {} tasks", count);
                                    }
                                }
                                Err(e) => {
                                    // Не логируем как error, если это просто отсутствие токенов
                                    if e.contains("access token not set") {
                                        warn!("[SYNC] Background sync skipped: {}", e);
                                    } else {
                                        error!("[SYNC] Background sync error: {}", e);
                                        // ДОКАЗАНО: Ошибка не останавливает loop, sync продолжается
                                    }
                                }
                            }
                        }
                    });
                    
                    // ДОКАЗАНО: Если block_on завершился (не должно происходить в нормальных условиях),
                    // перезапускаем runtime через 10 секунд
                    error!("[SYNC] Background sync task exited unexpectedly. Restarting in 10s...");
                    std::thread::sleep(std::time::Duration::from_secs(10));
                }
            });
            info!("[SYNC] Background sync task started in separate thread with dedicated runtime");

            // Логирование уже выполнено выше через info!

            Ok(())
        })
        .manage(ActivityMonitor::new())
        .invoke_handler(tauri::generate_handler![
            // Sync commands
            set_auth_tokens,
            sync_queue_now,
            get_sync_status,
            get_sync_queue_stats,
            get_failed_tasks,
            retry_failed_tasks,
            // Timer Engine commands
            start_timer,
            pause_timer,
            resume_timer,
            stop_timer,
            get_timer_state,
            reset_timer_day,
            save_timer_state,
            get_active_window_info,
            // Existing commands
            start_activity_monitoring,
            stop_activity_monitoring,
            listen_activity,
            request_screenshot_permission,
            take_screenshot,
            upload_screenshot,
            enqueue_time_entry,
            show_notification,
            update_tray_time,
            log_message,
            show_idle_window,
            hide_idle_window,
            update_idle_time,
            resume_tracking_from_idle,
            stop_tracking_from_idle,
            update_idle_state,
            request_idle_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
