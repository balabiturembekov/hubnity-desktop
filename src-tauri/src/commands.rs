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
use tauri::{AppHandle, Emitter, Manager, State};
#[allow(unused_imports)]
use tracing::{debug, info, warn};

/// Activity detection constants and logic (testable).
pub(crate) mod activity_emit {
    use std::time::{Duration, Instant};

    pub const ACTIVITY_THRESHOLD: Duration = Duration::from_secs(5);
    pub const MIN_EMIT_INTERVAL: Duration = Duration::from_secs(10);

    /// Returns true if we should emit activity-detected: idle < threshold and enough time since last emit.
    pub fn should_emit(idle_duration: Duration, last_emit_time: Instant) -> bool {
        idle_duration < ACTIVITY_THRESHOLD && Instant::now().duration_since(last_emit_time) >= MIN_EMIT_INTERVAL
    }
}

#[cfg(test)]
mod activity_emit_tests {
    use super::activity_emit::{should_emit, ACTIVITY_THRESHOLD, MIN_EMIT_INTERVAL};
    use std::time::{Duration, Instant};

    #[test]
    fn test_should_emit_idle_below_threshold_after_interval() {
        let last_emit = Instant::now() - MIN_EMIT_INTERVAL - Duration::from_secs(1);
        assert!(should_emit(Duration::from_secs(2), last_emit));
        assert!(should_emit(Duration::from_secs(0), last_emit));
    }

    #[test]
    fn test_should_not_emit_idle_above_threshold() {
        let last_emit = Instant::now() - MIN_EMIT_INTERVAL - Duration::from_secs(1);
        assert!(!should_emit(Duration::from_secs(5), last_emit));
        assert!(!should_emit(Duration::from_secs(10), last_emit));
    }

    #[test]
    fn test_should_not_emit_before_min_interval() {
        let last_emit = Instant::now() - Duration::from_secs(5);
        assert!(!should_emit(Duration::from_secs(2), last_emit));
    }

    #[test]
    fn test_threshold_boundary() {
        let last_emit = Instant::now() - MIN_EMIT_INTERVAL - Duration::from_secs(1);
        // 4s < 5s — активность, emit
        assert!(should_emit(Duration::from_secs(4), last_emit));
        // 5s >= 5s — порог, не emit
        assert!(!should_emit(Duration::from_secs(5), last_emit));
        // 4.999s < 5s — emit
        assert!(should_emit(Duration::from_millis(4999), last_emit));
    }

    #[test]
    fn test_interval_boundary() {
        let idle = Duration::from_secs(2);
        // 9s с прошлого emit — ещё рано
        let last_emit_9s = Instant::now() - Duration::from_secs(9);
        assert!(!should_emit(idle, last_emit_9s));
        // 10s — можно emit
        let last_emit_10s = Instant::now() - MIN_EMIT_INTERVAL;
        assert!(should_emit(idle, last_emit_10s));
    }

    #[test]
    fn test_constants() {
        assert_eq!(ACTIVITY_THRESHOLD, Duration::from_secs(5));
        assert_eq!(MIN_EMIT_INTERVAL, Duration::from_secs(10));
    }
}

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
        use std::time::Duration;
        use system_idle_time::get_idle_time;

        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        // Use system idle time instead of mouse position — more reliable, no false positives
        // when user is away (NSEvent.mouseLocation could drift due to Retina scaling, etc.)
        tokio::spawn(async move {
            use tauri::Emitter;
            let mut last_emit_time = Instant::now();

            loop {
                {
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break,
                    };
                    if !*monitoring {
                        break;
                    }
                }

                let idle_duration = match get_idle_time() {
                    Ok(d) => Some(d),
                    Err(e) => {
                        drop(e); // Box<dyn StdError> is not Send
                        None
                    }
                };
                let Some(idle_duration) = idle_duration else {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                };

                if activity_emit::should_emit(idle_duration, last_emit_time) {
                    let now = Instant::now();
                    if let Ok(mut last) = last_activity_clone.lock() {
                        *last = Instant::now();
                    }
                    let idle_secs = idle_duration.as_secs() as u32;
                    if let Err(e) = app_clone.emit("activity-detected", idle_secs) {
                        warn!("[ACTIVITY] Failed to emit activity-detected event: {:?}", e);
                    }
                    last_emit_time = now;
                }

                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        use std::time::Duration;
        use system_idle_time::get_idle_time;

        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            use tauri::Emitter;
            let mut last_emit_time = Instant::now();

            loop {
                {
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break,
                    };
                    if !*monitoring {
                        break;
                    }
                }

                let idle_duration = match get_idle_time() {
                    Ok(d) => Some(d),
                    Err(e) => {
                        drop(e);
                        None
                    }
                };
                let Some(idle_duration) = idle_duration else {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                };

                if activity_emit::should_emit(idle_duration, last_emit_time) {
                    let now = Instant::now();
                    if let Ok(mut last) = last_activity_clone.lock() {
                        *last = Instant::now();
                    }
                    let idle_secs = idle_duration.as_secs() as u32;
                    if let Err(e) = app_clone.emit("activity-detected", idle_secs) {
                        warn!("[ACTIVITY] Failed to emit activity-detected event: {:?}", e);
                    }
                    last_emit_time = now;
                }

                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: use system idle time
        use std::time::Duration;
        use system_idle_time::get_idle_time;

        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            use tauri::Emitter;
            let mut last_emit_time = Instant::now();

            loop {
                {
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break,
                    };
                    if !*monitoring {
                        break;
                    }
                }

                let idle_duration = match get_idle_time() {
                    Ok(d) => Some(d),
                    Err(e) => {
                        drop(e);
                        None
                    }
                };
                let Some(idle_duration) = idle_duration else {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                };

                if activity_emit::should_emit(idle_duration, last_emit_time) {
                    let now = Instant::now();
                    if let Ok(mut last) = last_activity_clone.lock() {
                        *last = Instant::now();
                    }
                    let idle_secs = idle_duration.as_secs() as u32;
                    if let Err(e) = app_clone.emit("activity-detected", idle_secs) {
                        warn!("[ACTIVITY] Failed to emit activity-detected event: {:?}", e);
                    }
                    last_emit_time = now;
                }

                tokio::time::sleep(Duration::from_secs(1)).await;
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

    #[cfg(target_os = "windows")]
    {
        // On Windows, try to get screens to check if screenshot functionality is available
        // This will trigger any necessary permission prompts if the system requires them
        match screenshots::Screen::all() {
            Ok(screens) => {
                if screens.is_empty() {
                    Ok(false)
                } else {
                    // BUG FIX: Use safe access method instead of indexing to prevent panic
                    // This should never fail because we check is_empty above, but defensive programming
                    match screens.first() {
                        Some(screen) => {
                            match screen.capture() {
                                Ok(_) => Ok(true),
                                Err(_) => Ok(false),
                            }
                        }
                        None => Ok(false),
                    }
                }
            }
            Err(_) => Ok(false),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux and other platforms
        match screenshots::Screen::all() {
            Ok(screens) => Ok(!screens.is_empty()),
            Err(_) => Ok(false),
        }
    }
}

/// Максимальный размер тела скриншота (защита от DoS/OOM при вызове из фронта).
const MAX_SCREENSHOT_BODY_BYTES: usize = 15 * 1024 * 1024; // 15 MB

#[tauri::command]
pub async fn upload_screenshot(
    png_data: Vec<u8>,
    time_entry_id: String,
    access_token: String,
    refresh_token: Option<String>,
    sync_manager: State<'_, SyncManager>,
) -> Result<(), String> {
    if png_data.len() > MAX_SCREENSHOT_BODY_BYTES {
        return Err(format!(
            "Screenshot too large ({} bytes, max {} MB)",
            png_data.len(),
            MAX_SCREENSHOT_BODY_BYTES / (1024 * 1024)
        ));
    }
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
        #[cfg(target_os = "macos")]
        let err_msg = format!(
            "Failed to get screens: {:?}. Please grant screen recording permission in System Settings -> Privacy & Security -> Screen Recording.",
            e
        );
        #[cfg(not(target_os = "macos"))]
        let err_msg = format!(
            "Failed to get screens: {:?}. Please ensure the application has necessary permissions to capture screenshots.",
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

    // BUG FIX: Use safe access method instead of indexing to prevent panic
    // This should never fail because we check is_empty above, but defensive programming
    let screen = screens.first().expect("BUG: screens is empty after is_empty check - this should never happen");

    // Capture screenshot
    let image = screen.capture().map_err(|e| {
        #[cfg(target_os = "macos")]
        let err_msg = format!(
            "Failed to capture screenshot: {:?}. Please check screen recording permissions in System Settings -> Privacy & Security -> Screen Recording.",
            e
        );
        #[cfg(not(target_os = "macos"))]
        let err_msg = format!(
            "Failed to capture screenshot: {:?}. Please ensure the application has necessary permissions to capture screenshots.",
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

    // Hide idle window immediately when user clicks Resume — main window handles resume in background
    // Fixes: on Windows the window stayed visible when store's hide_idle_window wasn't reached
    if let Some(idle_window) = app.get_webview_window("idle") {
        let _ = idle_window.hide();
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

    // Hide idle window immediately when user clicks Stop
    if let Some(idle_window) = app.get_webview_window("idle") {
        let _ = idle_window.hide();
    }

    Ok(())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> Result<String, String> {
    let package_info = app.package_info();
    Ok(package_info.version.to_string())
}

#[tauri::command]
pub async fn update_idle_state(
    idle_pause_start_time: Option<u64>,
    is_loading: bool,
    last_activity_time: Option<u64>,
    project_name: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    debug!(
        "update_idle_state: idle_pause_start_time={:?}, last_activity_time={:?}, is_loading={}, project_name={:?}",
        idle_pause_start_time, last_activity_time, is_loading, project_name
    );

    // Convert Option<u64> to number or null for JSON
    let pause_time_json = match idle_pause_start_time {
        Some(t) => serde_json::Value::Number(serde_json::Number::from(t)),
        None => serde_json::Value::Null,
    };
    let last_activity_json = match last_activity_time {
        Some(t) => serde_json::Value::Number(serde_json::Number::from(t)),
        None => serde_json::Value::Null,
    };
    let project_name_json = match &project_name {
        Some(n) => serde_json::Value::String(n.clone()),
        None => serde_json::Value::Null,
    };

    let payload = serde_json::json!({
        "idlePauseStartTime": pause_time_json,
        "lastActivityTime": last_activity_json,
        "isLoading": is_loading,
        "projectName": project_name_json,
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
        // BUG FIX: Use safe access methods instead of indexing to prevent panic
        let app_name = parts.first()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        
        let window_title = parts.get(1)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

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

/// Установить токены для синхронизации (вызывается из frontend).
/// Сброс таймера и очереди — только при смене пользователя (A → B); при входе после логаута ("" → A) не сбрасываем.
#[tauri::command]
pub async fn set_auth_tokens(
    sync_manager: State<'_, SyncManager>,
    engine: State<'_, Arc<crate::engine::TimerEngine>>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    user_id: Option<String>,
) -> Result<(), String> {
    let new_id = user_id.as_deref().unwrap_or("");
    let current_id = sync_manager
        .db
        .get_app_meta("current_user_id")
        .map_err(|e| format!("Failed to get current user: {}", e))?
        .unwrap_or_default();
    let has_tokens = access_token.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    // Сброс таймера и данных только при смене пользователя (A → B), не при входе после логаута ("" → A)
    if !new_id.is_empty() && !current_id.is_empty() && new_id != current_id {
        sync_manager
            .db
            .clear_user_data()
            .map_err(|e| format!("Failed to clear user data: {}", e))?;
        engine
            .reset_state()
            .map_err(|e| format!("Failed to reset timer: {}", e))?;
        sync_manager
            .db
            .set_app_meta("current_user_id", new_id)
            .map_err(|e| format!("Failed to set current user: {}", e))?;
    } else if new_id.is_empty() && !current_id.is_empty() && !has_tokens {
        // Logout: НЕ сбрасываем таймер - активный time entry продолжает работать на сервере
        // При повторном входе loadActiveTimeEntry() восстановит активный time entry и синхронизирует Timer Engine
        // Очищаем только current_user_id для безопасности
        sync_manager
            .db
            .set_app_meta("current_user_id", "")
            .map_err(|e| format!("Failed to clear current user: {}", e))?;
    } else if !new_id.is_empty() {
        sync_manager
            .db
            .set_app_meta("current_user_id", new_id)
            .map_err(|e| format!("Failed to set current user: {}", e))?;
    }
    sync_manager
        .auth_manager
        .set_tokens(access_token.clone(), refresh_token.clone())
        .await;
    // debug вместо info — иначе спам в логах при частых вызовах (pushTokensAndSync, Settings)
    if let Some(token) = &access_token {
        debug!("[SYNC] Tokens set in AuthManager, token length: {}", token.len());
    } else {
        debug!("[SYNC] Tokens cleared in AuthManager");
    }
    Ok(())
}

/// Получить текущий user_id из БД (для проверки смены пользователя на фронтенде)
#[tauri::command]
pub async fn get_current_user_id(
    sync_manager: State<'_, SyncManager>,
) -> Result<Option<String>, String> {
    sync_manager
        .db
        .get_app_meta("current_user_id")
        .map_err(|e| format!("Failed to get current user: {}", e))
}

#[tauri::command]
pub async fn sync_queue_now(sync_manager: State<'_, SyncManager>) -> Result<usize, String> {
    let pending = sync_manager.db.get_pending_count()
        .map_err(|e| format!("Failed to get pending count: {}", e))?;
    info!("[SYNC] sync_queue_now: {} pending tasks", pending);
    let result = sync_manager.sync_queue(5).await
        .map_err(|e| e.to_string())?;
    info!("[SYNC] sync_queue_now: synced {} tasks", result);
    Ok(result)
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

    let last_sync_at = sync_manager
        .db
        .get_app_meta("last_sync_at")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok());

    Ok(SyncStatusResponse {
        pending_count,
        failed_count,
        is_online,
        last_sync_at,
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

/// Пометить задачу как sent (успешно синхронизированную) — используется при прямом вызове API
#[tauri::command]
pub async fn mark_task_sent_by_id(
    id: i64,
    sync_manager: State<'_, SyncManager>,
) -> Result<(), String> {
    sync_manager.db.mark_task_sent(id).map_err(|e| {
        format!("Failed to mark task sent: {}", e)
    })?;
    let _ = sync_manager.db.set_app_meta(
        "last_sync_at",
        &chrono::Utc::now().timestamp().to_string(),
    );
    Ok(())
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
    // BUG FIX: Log error if sync fails instead of silently ignoring
    if let Err(e) = sync_manager.sync_queue(5).await {
        warn!("[RETRY] Failed to sync queue after retry (non-critical): {}", e);
    }

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

/// Пауза при idle — исключаем время простоя из accumulated
/// work_elapsed_secs = (lastActivityTime/1000) - session_start
#[tauri::command]
pub async fn pause_timer_idle(
    work_elapsed_secs: u64,
    engine: State<'_, Arc<TimerEngine>>,
) -> Result<TimerStateResponse, String> {
    engine.pause_with_work_elapsed(work_elapsed_secs)?;
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
