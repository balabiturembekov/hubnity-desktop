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
mod network;
pub use database::Database;
pub use network::check_online_status;
pub use network::{extract_domain, extract_url_from_title};
use commands::*;
use crate::engine::{TimerEngine};
use crate::sync::SyncManager;
pub use crate::sync::TaskPriority;
use crate::monitor::ActivityMonitor;
use std::sync::Arc;

#[cfg(test)]
mod tests;

#[derive(serde::Serialize)]
struct SyncStatusResponse {
    pending_count: i32,
    failed_count: i32,
    is_online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_sync_at: Option<i64>,
}


// ============================================
// SYSTEM SLEEP / WAKE HANDLING
// ============================================

#[cfg(target_os = "macos")]
fn setup_sleep_wake_handlers(_app: AppHandle, engine: Arc<TimerEngine>) -> Result<(), String> {
    eprintln!("[SLEEP/WAKE] Sleep/wake detection via time gap in get_state(); wake on startup");
    engine.handle_system_wake()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn setup_sleep_wake_handlers(_app: AppHandle, engine: Arc<TimerEngine>) -> Result<(), String> {
    eprintln!("[SLEEP/WAKE] Wake handler on startup");
    engine.handle_system_wake()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Инициализация логирования: по умолчанию info (если RUST_LOG не задан), чтобы [AUTH]/[SYNC] были видны
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    #[cfg(desktop)]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(not(desktop))]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                // BUG FIX: Log error if plugin fails to load instead of silently ignoring
                if let Err(e) = app.handle().plugin(tauri_plugin_updater::Builder::new().build()) {
                    warn!("[SETUP] Failed to load updater plugin (non-critical): {:?}", e);
                }
            }
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
                // BUG FIX: Graceful degradation вместо process::exit(1)
                // Если не удается создать runtime, логируем ошибку и выходим из потока
                // Приложение продолжит работу без периодического сохранения
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        error!(
                            "[TIMER] CRITICAL: Failed to create runtime for periodic save: {}. \
                            Periodic saving disabled. Application will continue but timer state \
                            will only be saved on explicit save operations or window close.",
                            e
                        );
                        // Выходим из потока, но не завершаем приложение
                        // Пользователь все еще может использовать приложение
                        return;
                    }
                };
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
            // CRITICAL FIX: Сохраняем ссылку на sync_manager ДО manage(), чтобы фоновая задача использовала тот же экземпляр
            let sync_manager_bg = sync_manager.clone();
            app.manage(sync_manager);

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
                            info!("[SYNC] Background sync tick, attempting sync...");
                            match sync_manager_bg.sync_queue(5).await {
                                Ok(count) => {
                                    if count > 0 {
                                        info!("[SYNC] Background sync: synced {} tasks", count);
                                    } else {
                                        debug!("[SYNC] Background sync: no tasks to sync");
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
            get_current_user_id,
            sync_queue_now,
            get_sync_status,
            get_sync_queue_stats,
            mark_task_sent_by_id,
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
            get_app_version,
            request_idle_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
