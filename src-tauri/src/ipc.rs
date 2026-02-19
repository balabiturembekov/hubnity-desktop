//! Centralized IPC event and command names.
//! Prevents typos and enables type-safe references across Rust and TypeScript.

/// Tauri event names (Rust emit ↔ Frontend listen)
pub mod events {
    pub const TIMER_STATE_UPDATE: &str = "timer-state-update";
    pub const ACTIVITY_DETECTED: &str = "activity-detected";
    pub const IDLE_STATE_UPDATE: &str = "idle-state-update";
    pub const DB_RECOVERED: &str = "db-recovered-from-corruption";
    pub const RESUME_TRACKING: &str = "resume-tracking";
    pub const STOP_TRACKING: &str = "stop-tracking";
    pub const REQUEST_IDLE_STATE: &str = "request-idle-state-for-idle-window";
    /// Emitted when sleep detected and timer auto-paused. Frontend can suppress activity for 30s.
    pub const SYSTEM_SLEEP_DETECTED: &str = "system-sleep-detected";
}

/// Tauri command names (Frontend invoke → Rust handler)
/// Kept for API contract; frontend uses src/lib/ipc.ts. Rust handlers use fn names.
#[allow(dead_code)]
pub mod commands {
    pub const TAKE_SCREENSHOT: &str = "take_screenshot";
    pub const TAKE_SCREENSHOT_TO_TEMP: &str = "take_screenshot_to_temp";
    pub const UPLOAD_SCREENSHOT: &str = "upload_screenshot";
    pub const UPLOAD_SCREENSHOT_FROM_PATH: &str = "upload_screenshot_from_path";
    pub const DELETE_SCREENSHOT_TEMP_FILE: &str = "delete_screenshot_temp_file";
}
