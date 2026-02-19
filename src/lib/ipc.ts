/**
 * Centralized IPC event and command names.
 * Must stay in sync with src-tauri/src/ipc.rs
 */

export const IPC_EVENTS = {
  TIMER_STATE_UPDATE: 'timer-state-update',
  ACTIVITY_DETECTED: 'activity-detected',
  IDLE_STATE_UPDATE: 'idle-state-update',
  DB_RECOVERED: 'db-recovered-from-corruption',
  RESUME_TRACKING: 'resume-tracking',
  STOP_TRACKING: 'stop-tracking',
  REQUEST_IDLE_STATE: 'request-idle-state-for-idle-window',
  /** Emitted when sleep detected; frontend can suppress activity for 30s (get_idle_time reset) */
  SYSTEM_SLEEP_DETECTED: 'system-sleep-detected',
} as const;

export const IPC_COMMANDS = {
  TAKE_SCREENSHOT: 'take_screenshot',
  TAKE_SCREENSHOT_TO_TEMP: 'take_screenshot_to_temp',
  UPLOAD_SCREENSHOT: 'upload_screenshot',
  UPLOAD_SCREENSHOT_FROM_PATH: 'upload_screenshot_from_path',
  DELETE_SCREENSHOT_TEMP_FILE: 'delete_screenshot_temp_file',
} as const;
