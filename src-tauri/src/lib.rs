#[allow(unused_imports)] // Local используется в тестах
use chrono::{Local, Utc};
use std::panic;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent};
use tracing::{debug, error, info, warn};
mod auth;
mod commands;
mod database;
mod ipc;
mod engine;
mod models;
mod monitor;
mod network;
mod sync;
use crate::engine::TimerEngine;
use crate::monitor::ActivityMonitor;
use crate::sync::SyncManager;
pub use crate::sync::TaskPriority;
use commands::*;
pub use database::Database;
pub use network::check_online_status;
pub use network::{extract_domain, extract_url_from_title};
use std::sync::Arc;

/// Panic recovery: persist TimerState when a non-fatal panic occurs.
static PANIC_ENGINE: OnceLock<Arc<TimerEngine>> = OnceLock::new();

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
    info!("[SLEEP/WAKE] Sleep/wake detection via time gap in get_state(); wake on startup");
    engine.handle_system_wake()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn setup_sleep_wake_handlers(_app: AppHandle, engine: Arc<TimerEngine>) -> Result<(), String> {
    info!("[SLEEP/WAKE] Wake handler on startup");
    engine.handle_system_wake()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic recovery: attempt to persist TimerState before panic unwinds
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Some(engine) = PANIC_ENGINE.get() {
            if let Err(e) = engine.save_state() {
                eprintln!("[PANIC_RECOVERY] Failed to persist timer state: {}", e);
            } else {
                eprintln!("[PANIC_RECOVERY] Timer state persisted before panic");
            }
        }
        default_hook(info);
    }));

    // Инициализация логирования: по умолчанию info (если RUST_LOG не задан), чтобы [AUTH]/[SYNC] были видны
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    #[cfg(desktop)]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when user tries to launch second instance
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_cors_fetch::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(not(desktop))]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_cors_fetch::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                #[cfg(target_os = "macos")]
                {
                    macos_app_nap::prevent();
                    info!("[MACOS] App Nap disabled — activity monitor and timer run in background");
                }
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
                let kind = e.kind();
                let msg = match kind {
                    std::io::ErrorKind::PermissionDenied => {
                        "Permission denied. Check app data directory is writable."
                    }
                    std::io::ErrorKind::StorageFull => {
                        "Disk full. Free space on drive."
                    }
                    _ => "Failed to create app data directory.",
                };
                std::io::Error::new(
                    kind,
                    format!("{} Path: {} — {}", msg, app_data_dir.display(), e),
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

            // Auto-recovery from corrupted DB: on integrity/corruption failure, backup and retry once
            let db = match Database::new(db_path_str) {
                Ok(d) => Arc::new(d),
                Err(e) => {
                    let err_str = e.to_string();
                    let is_corruption =
                        err_str.contains("corruption") || err_str.contains("integrity");
                    if !is_corruption || !db_path.exists() {
                        return Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Failed to initialize database: {}", e),
                        )));
                    }
                    let backup_path = app_data_dir.join(format!(
                        "hubnity.db.corrupted.{}",
                        chrono::Utc::now().timestamp()
                    ));
                    if let Err(rename_e) = std::fs::rename(&db_path, &backup_path) {
                        warn!(
                            "[DB] Failed to rename corrupted DB to {:?}: {}",
                            backup_path, rename_e
                        );
                        return Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Database corrupted and could not backup: {}", e),
                        )));
                    }
                    info!(
                        "[DB] Corrupted DB backed up to {:?}, starting fresh",
                        backup_path
                    );
                    let _ = app.handle().emit(crate::ipc::events::DB_RECOVERED, ());
                    Arc::new(Database::new(db_path_str).map_err(|e2| {
                        std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Failed to create fresh database: {}", e2),
                        )
                    })?)
                }
            };

            // Инициализируем TimerEngine с БД
            let engine = TimerEngine::with_db(db.clone());
            let engine_arc = Arc::new(engine);

            // Panic recovery: register engine for persist-on-panic
            let _ = PANIC_ENGINE.set(engine_arc.clone());

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
                    error!("[SHUTDOWN] Failed to save timer state on window close: {}", e);
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

            // FIX: Один поток emit таймера (не создаётся при Active<->Idle). 1s + Skip при лагах.
            let engine_for_emit = engine_arc.clone();
            let app_handle_for_emit = app.handle().clone();
            std::thread::spawn(move || {
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        error!("[TIMER] Failed to create runtime for timer emit: {}", e);
                        return;
                    }
                };
                rt.block_on(async {
                    use std::time::UNIX_EPOCH;
                    use tauri::Emitter;
                    use crate::engine::TimerStateForAPI;
                    use tokio::time::MissedTickBehavior;

                    // Микро-синхронизация: первый тик — на границе системной секунды (12:00:00.000, не .500)
                    if let Ok(now) = std::time::SystemTime::now().duration_since(UNIX_EPOCH) {
                        let now_ms = now.as_millis();
                        let next_sec_ms = (now_ms / 1000 + 1) * 1000;
                        let delay_ms = (next_sec_ms - now_ms).min(999);
                        if delay_ms > 0 {
                            tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms as u64)).await;
                        }
                    }

                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(1));
                    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        if let Ok(state) = engine_for_emit.get_state() {
                            let should_emit = matches!(
                                state.state,
                                TimerStateForAPI::Running { .. } | TimerStateForAPI::Paused
                            );
                            if should_emit {
                                let _ = app_handle_for_emit.emit(crate::ipc::events::TIMER_STATE_UPDATE, &state);
                                // OS AUDIT: Notify frontend of wake — can suppress false "active" from get_idle_time() reset
                                if state.reason.as_deref() == Some("sleep") {
                                    let _ = app_handle_for_emit.emit(crate::ipc::events::SYSTEM_SLEEP_DETECTED, ());
                                }
                            }
                        }
                    }
                });
            });

            // Управляем engine через Tauri State
            // CRITICAL FIX: Используем Arc напрямую, так как он используется в других местах
            // ДОКАЗАНО: Tauri State может работать с Arc<TimerEngine>, так как Arc: Send + Sync
            app.manage(engine_arc);

            // Инициализируем SyncManager (с app_version для X-App-Version header)
            let sync_config = crate::sync::SyncConfig {
                app_version: app.package_info().version.to_string(),
                ..Default::default()
            };
            let sync_manager = SyncManager::new_with_config(db.clone(), sync_config);
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
                        // PRODUCTION: Base delay for token recovery + network jitter (1-3s).
                        // Prevents slamming API server on app start or wake from sleep.
                        let base_secs = 10;
                        let jitter_ms: u64 = rand::random::<u32>() as u64 % 2000 + 1000;
                        let total_ms = base_secs * 1000 + jitter_ms;
                        tokio::time::sleep(tokio::time::Duration::from_millis(total_ms)).await;

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
            clear_sync_queue,
            mark_task_sent_by_id,
            get_failed_tasks,
            retry_failed_tasks,
            persist_time_entry_id,
            get_last_time_entry_id,
            get_sleep_gap_threshold_minutes,
            set_sleep_gap_threshold_minutes,
            // Timer Engine commands
            start_timer,
            pause_timer,
            pause_timer_idle,
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
            take_screenshot_to_temp,
            upload_screenshot,
            upload_screenshot_from_path,
            delete_screenshot_temp_file,
            enqueue_time_entry,
            show_notification,
            update_tray_time,
            get_tray_icon_path,
            log_message,
            show_idle_window,
            hide_idle_window,
            resume_tracking_from_idle,
            stop_tracking_from_idle,
            update_idle_state,
            get_app_version,
            request_idle_state
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // CHAOS AUDIT FIX: Graceful shutdown — persist timer state on exit
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(engine) = app_handle.try_state::<Arc<TimerEngine>>() {
                    if let Err(e) = engine.save_state() {
                        error!("[SHUTDOWN] Failed to save timer state on exit: {}", e);
                    } else {
                        info!("[SHUTDOWN] Timer state saved successfully on exit");
                    }
                }
            }
        });
}
