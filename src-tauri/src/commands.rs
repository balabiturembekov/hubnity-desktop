use crate::engine::{TimerEngine, TimerStateResponse};
use crate::models::ActiveWindowInfo;
use crate::models::{FailedTaskInfo, QueueStats};
use crate::monitor::ActivityMonitor;
use crate::sync::SyncManager;
use crate::SyncStatusResponse;
use crate::check_online_status;
#[cfg(target_os = "macos")]
use crate::extract_url_from_title;
use std::sync::Arc;
use std::time::Instant;
#[allow(unused_imports)] // Emitter used in #[cfg(not(target_os = "macos"))] activity branch
use tauri::{AppHandle, Emitter, State};
#[allow(unused_imports)]
use tracing::{debug, info, warn};

#[tauri::command]
pub async fn start_activity_monitoring(
    monitor: State<'_, ActivityMonitor>,
    app: AppHandle,
) -> Result<(), String> {
    let is_monitoring = monitor.is_monitoring.clone();
    let last_activity = monitor.last_activity.clone();

    // Use a single lock to check and set atomically to prevent race conditions
    {
        let mut monitoring = is_monitoring
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        if *monitoring {
            return Ok(()); // Already monitoring
        }
        *monitoring = true;
    } // Lock is released here before spawning the task

    // Update last activity time
    {
        let mut last = last_activity
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        *last = Instant::now();
    }

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Class;
        use objc::{msg_send, sel, sel_impl};
        use std::time::Duration;

        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        // Spawn a thread for activity monitoring by checking mouse position
        tokio::spawn(async move {
            use tauri::Emitter;
            let mut last_mouse_pos: Option<(f64, f64)> = None;
            let mut last_emit_time = Instant::now();
            let min_emit_interval = Duration::from_secs(10); // Emit activity event at most once every 10 seconds
            let mut consecutive_movements = 0; // Track consecutive small movements

            loop {
                {
                    // Check if monitoring should continue
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break, // Mutex poisoned, exit loop
                    };
                    if !*monitoring {
                        break;
                    }
                }

                // Get current mouse position using NSEvent.mouseLocation through objc
                unsafe {
                    let ns_event_class = match Class::get("NSEvent") {
                        Some(class) => class,
                        None => {
                            // Class not found, skip this iteration
                            tokio::time::sleep(Duration::from_millis(1000)).await;
                            continue;
                        }
                    };
                    let mouse_location: core_graphics::geometry::CGPoint =
                        msg_send![ns_event_class, mouseLocation];

                    let current_mouse_pos = (mouse_location.x, mouse_location.y);

                    // Check if mouse moved significantly
                    let mut activity_detected = false;
                    if let Some((last_x, last_y)) = last_mouse_pos {
                        let delta_x = (current_mouse_pos.0 - last_x).abs();
                        let delta_y = (current_mouse_pos.1 - last_y).abs();
                        let total_delta = (delta_x * delta_x + delta_y * delta_y).sqrt();

                        // If mouse moved more than 20 pixels, consider it real activity
                        // This filters out small hand tremors and system noise
                        if total_delta > 20.0 {
                            activity_detected = true;
                            consecutive_movements = 0; // Reset counter on significant movement
                        } else if total_delta > 1.0 {
                            // Small movement - increment counter
                            consecutive_movements += 1;
                            // If many small movements accumulate, it might be real activity
                            if consecutive_movements >= 10 {
                                activity_detected = true;
                                consecutive_movements = 0;
                            }
                        } else {
                            // No movement - reset counter
                            consecutive_movements = 0;
                        }
                    } else {
                        // First check - don't emit immediately, just initialize
                        last_mouse_pos = Some(current_mouse_pos);
                        tokio::time::sleep(Duration::from_millis(1000)).await;
                        continue;
                    }

                    // Only emit event if activity detected AND enough time has passed since last emit
                    if activity_detected {
                        let now = Instant::now();
                        if now.duration_since(last_emit_time) >= min_emit_interval {
                            // Update activity time first (even if emit fails)
                            {
                                if let Ok(mut last) = last_activity_clone.lock() {
                                    *last = Instant::now();
                                }
                            }
                            // Emit event (ignore errors)
                            app_clone.emit("activity-detected", ()).ok();
                            last_emit_time = now;
                        }
                    }

                    last_mouse_pos = Some(current_mouse_pos);
                }

                // Check every 1 second to reduce CPU usage and false positives
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For other platforms, implement similar logic
        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            loop {
                {
                    // Check if monitoring should continue
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break, // Mutex poisoned, exit loop
                    };
                    if !*monitoring {
                        break;
                    }
                }

                app_clone.emit("activity-detected", ()).ok();

                {
                    if let Ok(mut last) = last_activity_clone.lock() {
                        *last = Instant::now();
                    }
                    // If mutex is poisoned, continue anyway
                }

                tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_activity_monitoring(monitor: State<'_, ActivityMonitor>) -> Result<(), String> {
    let mut monitoring = monitor
        .is_monitoring
        .lock()
        .map_err(|e| format!("Mutex poisoned: {}", e))?;
    *monitoring = false;
    Ok(())
}

#[tauri::command]
pub async fn listen_activity(_monitor: State<'_, ActivityMonitor>) -> Result<(), String> {
    // Activity monitoring is handled by start_activity_monitoring
    // This command exists for compatibility
    Ok(())
}

#[tauri::command]
pub async fn request_screenshot_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, screenshots crate will trigger permission request automatically
        // when trying to capture. We can check if we have permission by trying to get screens
        match screenshots::Screen::all() {
            Ok(_) => Ok(true),
            Err(_) => {
                // Permission not granted, but the system should prompt when we try to capture
                Ok(false)
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn upload_screenshot(
    png_data: Vec<u8>,
    time_entry_id: String,
    access_token: String,
    refresh_token: Option<String>,
    sync_manager: State<'_, SyncManager>,
) -> Result<(), String> {
    info!("[RUST] Enqueueing screenshot: {} bytes", png_data.len());

    // Сначала сохраняем в очередь
    let queue_id =
        sync_manager.enqueue_screenshot(png_data, time_entry_id, access_token, refresh_token)?;
    info!("[RUST] Screenshot enqueued with ID: {}", queue_id);

    // Сразу запускаем синхронизацию, чтобы скриншот ушёл на сервер (иначе GET /screenshots/time-entry/... будет пуст до следующего тика раз в 60 с)
    match sync_manager.sync_queue(5).await {
        Ok(count) => {
            if count > 0 {
                info!("[RUST] Sync after screenshot: {} task(s) sent", count);
            }
        }
        Err(e) => {
            warn!(
                "[RUST] Sync after screenshot failed (screenshot stays in queue): {}",
                e
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn enqueue_time_entry(
    operation: String,
    payload: serde_json::Value,
    access_token: String,
    refresh_token: Option<String>,
    sync_manager: State<'_, SyncManager>,
) -> Result<i64, String> {
    info!("[RUST] Enqueueing time entry operation: {}", operation);

    let queue_id =
        sync_manager.enqueue_time_entry(&operation, payload, access_token, refresh_token)?;
    info!("[RUST] Time entry operation enqueued with ID: {}", queue_id);

    Ok(queue_id)
}

#[tauri::command]
pub async fn take_screenshot(_time_entry_id: String) -> Result<Vec<u8>, String> {
    use image::{ImageBuffer, Rgba};

    // Take screenshot using screenshots crate
    let screens = screenshots::Screen::all().map_err(|e| {
        let err_msg = format!(
            "Failed to get screens: {:?}. Please grant screen recording permission in System Settings -> Privacy & Security -> Screen Recording.",
            e
        );
        eprintln!("[SCREENSHOT ERROR] {}", err_msg);
        err_msg
    })?;

    // Check if we have any screens available
    if screens.is_empty() {
        eprintln!("[SCREENSHOT ERROR] No screens available");
        return Err("No screens available".to_string());
    }

    // Use first screen without cloning (more efficient)
    let screen = &screens[0];

    // Capture screenshot
    let image = screen.capture().map_err(|e| {
        let err_msg = format!(
            "Failed to capture screenshot: {:?}. Please check screen recording permissions in System Settings.",
            e
        );
        eprintln!("[SCREENSHOT ERROR] {}", err_msg);
        err_msg
    })?;

    // Get image dimensions and RGBA data
    let width = image.width();
    let height = image.height();

    // Validate dimensions
    if width == 0 || height == 0 {
        eprintln!(
            "[SCREENSHOT ERROR] Invalid screenshot dimensions: {}x{}",
            width, height
        );
        return Err("Invalid screenshot dimensions".to_string());
    }

    // Get RGBA buffer from image (this is a reference, no copy yet)
    let rgba_data = image.rgba();

    // Create ImageBuffer from RGBA data - use as_raw() to avoid extra copy if possible
    // But we need to convert to Vec<u8> for ImageBuffer
    let img_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba_data.to_vec()).ok_or_else(|| {
            eprintln!("[SCREENSHOT ERROR] Failed to create ImageBuffer from RGBA data");
            "Failed to create ImageBuffer from RGBA data".to_string()
        })?;

    // If image is very large, resize it first to reduce file size
    // Target: max 1280x720 to keep file size under 1MB (for nginx limit)
    let max_width = 1280u32;
    let max_height = 720u32;
    let final_buffer = if width > max_width || height > max_height {
        eprintln!(
            "[SCREENSHOT] Image too large ({}x{}), resizing to max {}x{}",
            width, height, max_width, max_height
        );

        // Calculate new dimensions maintaining aspect ratio
        let aspect_ratio = width as f32 / height as f32;
        let (new_width, new_height) = if aspect_ratio > 1.0 {
            // Landscape
            if width > max_width {
                (max_width, (max_width as f32 / aspect_ratio) as u32)
            } else {
                ((max_height as f32 * aspect_ratio) as u32, max_height)
            }
        } else {
            // Portrait
            if height > max_height {
                ((max_height as f32 * aspect_ratio) as u32, max_height)
            } else {
                (max_width, (max_width as f32 / aspect_ratio) as u32)
            }
        };

        use image::imageops::resize;
        resize(
            &img_buffer,
            new_width,
            new_height,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img_buffer
    };

    // Convert to JPEG for smaller file size (PNG is too large for nginx limit)
    let final_width = final_buffer.width();
    let final_height = final_buffer.height();

    // Convert RGBA to RGB for JPEG (JPEG doesn't support alpha channel)
    use image::{DynamicImage, Rgb};
    let rgb_buffer: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_fn(final_width, final_height, |x, y| {
            let pixel = final_buffer.get_pixel(x, y);
            Rgb([pixel[0], pixel[1], pixel[2]])
        });

    // Convert to DynamicImage and encode as JPEG
    let dynamic_img = DynamicImage::ImageRgb8(rgb_buffer);
    let mut jpeg_bytes = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut jpeg_bytes);
        dynamic_img
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| {
                let err_msg = format!("Failed to encode JPEG: {:?}", e);
                eprintln!("[SCREENSHOT ERROR] {}", err_msg);
                err_msg
            })?;
    }

    // Validate that we actually have JPEG data
    if jpeg_bytes.is_empty() {
        eprintln!("[SCREENSHOT ERROR] Encoded JPEG data is empty");
        return Err("Screenshot encoding produced empty result".to_string());
    }

    eprintln!("[SCREENSHOT] Final JPEG size: {} bytes", jpeg_bytes.len());

    Ok(jpeg_bytes)
}

#[tauri::command]
pub async fn log_message(message: String) -> Result<(), String> {
    eprintln!("{}", message);
    Ok(())
}

#[tauri::command]
pub async fn show_notification(title: String, body: String, app: AppHandle) -> Result<(), String> {
    // Use Tauri notification plugin
    // Get Notification instance using NotificationExt trait
    use tauri_plugin_notification::NotificationExt;

    let notification = app.notification();

    notification
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("Failed to show notification: {:?}", e))?;

    Ok(())
}

// Note: System tray is now managed directly from the frontend using Tauri tray commands
// This command is kept for backward compatibility but does nothing
#[tauri::command]
pub async fn update_tray_time(
    _time_text: String,
    _is_tracking: bool,
    _is_paused: bool,
    _app: AppHandle,
) -> Result<(), String> {
    // System tray is now managed from frontend using plugin:tray commands
    Ok(())
}

#[tauri::command]
pub async fn show_idle_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // Get or create idle window
    if let Some(idle_window) = app.get_webview_window("idle") {
        // Window exists, just show it
        idle_window
            .show()
            .map_err(|e| format!("Failed to show idle window: {}", e))?;
        idle_window
            .set_focus()
            .map_err(|e| format!("Failed to focus idle window: {}", e))?;
    } else {
        // Window doesn't exist - it should be created from config, but if not, we'll try to create it
        // In Tauri 2.0, windows are typically created from config, so this should not happen
        return Err(
            "Idle window not found. Please ensure it's configured in tauri.conf.json".to_string(),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn hide_idle_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .hide()
            .map_err(|e| format!("Failed to hide idle window: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn update_idle_time(idle_seconds: u64, app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .emit("idle-time-update", idle_seconds)
            .map_err(|e| format!("Failed to emit idle time update: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn resume_tracking_from_idle(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // Emit event to main window to resume tracking
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("resume-tracking", ())
            .map_err(|e| format!("Failed to emit resume event: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_tracking_from_idle(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // Emit event to main window to stop tracking
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("stop-tracking", ())
            .map_err(|e| format!("Failed to emit stop event: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn update_idle_state(
    idle_pause_start_time: Option<u64>,
    is_loading: bool,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    debug!(
        "update_idle_state: idle_pause_start_time={:?}, is_loading={}",
        idle_pause_start_time, is_loading
    );

    // Convert Option<u64> to number or null for JSON
    let pause_time_json = match idle_pause_start_time {
        Some(t) => serde_json::Value::Number(serde_json::Number::from(t)),
        None => serde_json::Value::Null,
    };

    let payload = serde_json::json!({
        "idlePauseStartTime": pause_time_json,
        "isLoading": is_loading,
    });

    // Emit to idle window if it exists
    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .emit("idle-state-update", &payload)
            .map_err(|e| format!("Failed to emit idle state update: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn request_idle_state(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    debug!("request_idle_state: requesting state from main window");

    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("request-idle-state-for-idle-window", ())
            .map_err(|e| format!("Failed to emit request: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    #[cfg(target_os = "macos")]
    {
        // Используем AppleScript для безопасного получения информации об активном окне
        // AppleScript не вызывает Objective-C exceptions и работает стабильно

        use std::process::Command;

        // AppleScript для получения информации об активном приложении и окне
        let script = r#"
    tell application "System Events"
        try
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            
            try
                set frontWindow to first window of frontApp
                set windowTitle to title of frontWindow
            on error
                set windowTitle to ""
            end try
            
            return appName & "|" & windowTitle
        on error
            return ""
        end try
    end tell
"#;

        // Выполняем AppleScript через osascript
        let output = match Command::new("osascript").arg("-e").arg(script).output() {
            Ok(output) => output,
            Err(e) => {
                warn!("[ACTIVE_WINDOW] Failed to execute AppleScript: {}", e);
                return Ok(ActiveWindowInfo {
                    app_name: None,
                    window_title: None,
                    url: None,
                    domain: None,
                });
            }
        };

        // Проверяем успешность выполнения
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("[ACTIVE_WINDOW] AppleScript error: {}", stderr);
            return Ok(ActiveWindowInfo {
                app_name: None,
                window_title: None,
                url: None,
                domain: None,
            });
        }

        // Парсим результат
        let result = String::from_utf8_lossy(&output.stdout);
        let result = result.trim();

        if result.is_empty() {
            return Ok(ActiveWindowInfo {
                app_name: None,
                window_title: None,
                url: None,
                domain: None,
            });
        }

        // Разделяем результат: "AppName|WindowTitle"
        let parts: Vec<&str> = result.split('|').collect();
        let app_name = if parts.len() > 0 && !parts[0].is_empty() {
            Some(parts[0].to_string())
        } else {
            None
        };

        let window_title = if parts.len() > 1 && !parts[1].is_empty() {
            Some(parts[1].to_string())
        } else {
            None
        };

        // Извлекаем URL и domain из window_title (если это браузер)
        let (url, domain) = if let Some(ref title) = window_title {
            extract_url_from_title(title)
        } else {
            (None, None)
        };

        Ok(ActiveWindowInfo {
            app_name,
            window_title,
            url,
            domain,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For other platforms, return empty info for now
        Ok(ActiveWindowInfo {
            app_name: None,
            window_title: None,
            url: None,
            domain: None,
        })
    }
}

// ============================================
// TAURI COMMANDS для синхронизации
// ============================================

/// Установить токены для синхронизации (вызывается из frontend)
#[tauri::command]
pub async fn set_auth_tokens(
    sync_manager: State<'_, SyncManager>,
    access_token: Option<String>,
    refresh_token: Option<String>,
) -> Result<(), String> {
    let has_access = access_token
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_refresh = refresh_token
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    info!(
        "[AUTH] set_auth_tokens called: access_token present={}, refresh_token present={}",
        has_access, has_refresh
    );
    eprintln!("[AUTH] set_auth_tokens: token present={}", has_access);
    sync_manager
        .auth_manager
        .set_tokens(access_token, refresh_token)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn sync_queue_now(sync_manager: State<'_, SyncManager>) -> Result<usize, String> {
    sync_manager.sync_queue(5).await
}

/// Получить статус синхронизации (количество pending/failed задач)
#[tauri::command]
pub async fn get_sync_status(
    sync_manager: State<'_, SyncManager>,
) -> Result<SyncStatusResponse, String> {
    let pending_count = sync_manager
        .db
        .get_pending_count()
        .map_err(|e| format!("Failed to get pending count: {}", e))?;

    let failed_count = sync_manager
        .db
        .get_failed_count()
        .map_err(|e| format!("Failed to get failed count: {}", e))?;

    // Проверяем online статус через попытку HTTP запроса (легковесный HEAD запрос)
    let is_online = check_online_status().await;

    Ok(SyncStatusResponse {
        pending_count,
        failed_count,
        is_online,
    })
}

/// Получить детальную статистику очереди синхронизации
#[tauri::command]
pub async fn get_sync_queue_stats(
    sync_manager: State<'_, SyncManager>,
) -> Result<QueueStats, String> {
    sync_manager
        .db
        .get_queue_stats()
        .map_err(|e| format!("Failed to get queue stats: {}", e))
}

/// Получить список failed задач с деталями
#[tauri::command]
pub async fn get_failed_tasks(
    sync_manager: State<'_, SyncManager>,
    limit: Option<i32>,
) -> Result<Vec<FailedTaskInfo>, String> {
    let limit = limit.unwrap_or(50); // По умолчанию 50 задач
    sync_manager
        .db
        .get_failed_tasks(limit)
        .map_err(|e| format!("Failed to get failed tasks: {}", e))
}

/// Сбросить failed задачи обратно в pending для повторной попытки
#[tauri::command]
pub async fn retry_failed_tasks(
    sync_manager: State<'_, SyncManager>,
    limit: Option<i32>,
) -> Result<i32, String> {
    let limit = limit.unwrap_or(100); // По умолчанию 100 задач
    let count = sync_manager
        .db
        .reset_failed_tasks(limit)
        .map_err(|e| format!("Failed to reset failed tasks: {}", e))?;

    info!("[SYNC] Reset {} failed tasks back to pending", count);

    // PRODUCTION: Запускаем синхронизацию через sync-lock
    let _ = sync_manager.sync_queue(5).await;

    Ok(count)
}

// ============================================
// TAURI COMMANDS для Timer Engine
// ============================================

#[tauri::command]
pub async fn start_timer(
    engine: State<'_, Arc<TimerEngine>>,
) -> Result<TimerStateResponse, String> {
    engine.start()?;
    engine.get_state()
}

#[tauri::command]
pub async fn pause_timer(
    engine: State<'_, Arc<TimerEngine>>,
) -> Result<TimerStateResponse, String> {
    engine.pause()?;
    engine.get_state()
}

#[tauri::command]
pub async fn resume_timer(
    engine: State<'_, Arc<TimerEngine>>,
) -> Result<TimerStateResponse, String> {
    engine.resume()?;
    engine.get_state()
}

#[tauri::command]
pub async fn stop_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.stop()?;
    engine.get_state()
}

#[tauri::command]
pub async fn get_timer_state(
    engine: State<'_, Arc<TimerEngine>>,
) -> Result<TimerStateResponse, String> {
    engine.get_state()
}

#[tauri::command]
pub async fn reset_timer_day(engine: State<'_, Arc<TimerEngine>>) -> Result<(), String> {
    engine.reset_day()
}

#[tauri::command]
pub async fn save_timer_state(engine: State<'_, Arc<TimerEngine>>) -> Result<(), String> {
    engine.save_state()
}
