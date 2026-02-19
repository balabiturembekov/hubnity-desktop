# Deep Polish Audit — Final Report

**Date:** 2025  
**Scope:** Robustness, IPC, Memory, Sync, Clean Code

---

## 1. Invisible Risks Found

| Risk | Location | Severity | Status |
|------|----------|----------|--------|
| `saved_started_at.unwrap()` in DB recovery | `engine/db.rs` | Medium | ✅ Fixed — `if let (true, Some(raw))` |
| `strip_prefix().expect()` in sync | `sync/mod.rs` | Low | ✅ Fixed — `ok_or_else()?` |
| Orphan temp file when tempPath but no accessToken | `App.tsx` | Medium | ✅ Fixed — `delete_screenshot_temp_file` |
| Magic strings in events/commands | Rust + TS | Low | ✅ Fixed — `ipc.rs` + `ipc.ts` |
| `path.exists()` before remove_file | `upload_screenshot_from_path` | Trivial | ✅ Fixed — direct `remove_file` |
| Race: Start→Stop→Start in TimerEngine | `engine/core.rs` | Low | ✅ Safe — FSM + atomic Mutex |
| ActivityMonitor tokio::spawn not cancellable | `commands.rs` | Low | ⚠️ Acceptable — loop checks `is_monitoring` |

---

## 2. Robustness & Edge Cases

### 2.1 unwrap/expect Replacements

- **engine/db.rs:** `saved_started_at.unwrap()` → `if let (true, Some(raw)) = (state_str == "running", saved_started_at)` — idiomatic pattern.
- **sync/mod.rs:** `strip_prefix().expect(...)` → `ok_or_else(|| SyncError::UnknownOperation(...))?` — returns `Err` instead of panic.

### 2.2 Remaining unwrap/expect (Acceptable)

- **lib.rs:401** — `run().expect(...)` — application entry point; panic is appropriate.
- **tests.rs, monitor.rs** — Test code only; `unwrap`/`expect` acceptable.
- **database.rs** — `row.get(0)` — SQL column index; rusqlite API.
- **commands.rs:558** — `Rgb([pixel[0], pixel[1], pixel[2]])` — `get_pixel` returns fixed-size array; safe.

### 2.3 Race Conditions: TimerEngine & ActivityMonitor

**TimerEngine (Start→Stop→Start):**  
All transitions go through a single `Mutex`. FSM ensures only valid transitions. No interleaving of state changes.

**ActivityMonitor:**  
`tokio::spawn` loops check `is_monitoring` before each iteration. When `stop_activity_monitoring` sets it to `false`, the loop exits. No cancellation token needed — the loop naturally terminates.

---

## 3. Tauri IPC & Performance

### 3.1 Async Commands

All I/O-heavy commands are `async`. Sync commands (`get_tray_icon_path`, `get_sleep_gap_threshold_minutes`, `set_sleep_gap_threshold_minutes`, `get_app_version`) perform fast, in-memory or brief DB reads. Tauri runs sync commands on a thread pool — acceptable.

### 3.2 Screenshot Fallback

- **Primary:** `take_screenshot_to_temp` → `upload_screenshot_from_path` (no binary over IPC).
- **Fallback:** When `take_screenshot_to_temp` fails or `accessToken` is missing → `take_screenshot` (bytes) → `upload_screenshot` or JS `uploadScreenshot`.
- **Orphan fix:** When `tempPath` exists but no `accessToken`, `delete_screenshot_temp_file` is called to avoid leaving temp files.

### 3.3 Serde Optimization

No large structures cloned unnecessarily. `TimerStateResponse` is returned by value (small). Screenshot bytes use `Vec<u8>` — appropriate for binary data.

---

## 4. Memory & Resource Management

### 4.1 tokio::spawn Cancellation

Activity monitor spawns are self-terminating: they check `is_monitoring` each loop. No explicit cancellation needed. Background sync and periodic save use `std::thread::spawn` with infinite loops — they run for the app lifetime.

### 4.2 Database Connections

Single `Connection` in `Arc<Mutex<Connection>>`. No pooling. Lock is held only during DB operations (short). No connection leaks.

### 4.3 BaseDirectory::Temp Consistency

- **take_screenshot_to_temp:** Uses `app.path().resolve(filename, BaseDirectory::Temp)`.
- **database.rs:** `temp_store = MEMORY` — SQLite temp tables in RAM, not filesystem temp.
- **tests.rs:** Uses `tempfile::TempDir` for test DBs — appropriate for tests.

---

## 5. Frontend/Backend Synchronization

### 5.1 Event Names

| Rust emit | TS listen | Constant |
|-----------|-----------|----------|
| `timer-state-update` | Timer.tsx | `IPC_EVENTS.TIMER_STATE_UPDATE` |
| `activity-detected` | App.tsx | `IPC_EVENTS.ACTIVITY_DETECTED` |
| `idle-state-update` | IdleWindow.tsx | `IPC_EVENTS.IDLE_STATE_UPDATE` |
| `db-recovered-from-corruption` | App.tsx | `IPC_EVENTS.DB_RECOVERED` |
| `resume-tracking` | App.tsx | `IPC_EVENTS.RESUME_TRACKING` |
| `stop-tracking` | App.tsx | `IPC_EVENTS.STOP_TRACKING` |
| `request-idle-state-for-idle-window` | App.tsx | `IPC_EVENTS.REQUEST_IDLE_STATE` |

### 5.2 Centralized Constants

- **Rust:** `src-tauri/src/ipc.rs` — `events::`, `commands::`
- **TypeScript:** `src/lib/ipc.ts` — `IPC_EVENTS`, `IPC_COMMANDS`

---

## 6. Refactoring Applied

1. **engine/db.rs** — `if let` instead of `unwrap` for `saved_started_at`.
2. **sync/mod.rs** — `ok_or_else` instead of `expect` for `strip_prefix`.
3. **commands.rs** — `delete_screenshot_temp_file` for orphan temp files.
4. **commands.rs** — All `emit` calls use `crate::ipc::events::*`.
5. **lib.rs** — Emit calls use `crate::ipc::events::*`.
6. **App.tsx** — Screenshot flow: orphan cleanup, IPC constants.
7. **Timer.tsx, IdleWindow.tsx** — `listen` uses `IPC_EVENTS`.
8. **upload_screenshot_from_path** — Removed `path.exists()` before `remove_file`.

---

## 7. Error Messages

Existing errors are actionable (e.g. "Please grant screen recording permission", "Please restart the application to recover"). No changes needed.

---

## 8. Summary

| Category | Changes |
|----------|---------|
| Robustness | 2 unwrap/expect fixes |
| IPC | Centralized constants, orphan file cleanup |
| Memory | No leaks identified |
| Sync | FSM + Mutex verified safe |
| Clean Code | Guard clauses, idiomatic patterns |
