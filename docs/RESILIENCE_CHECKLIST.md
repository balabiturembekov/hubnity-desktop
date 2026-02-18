# OS Integration & Resilience Checklist

Audit of how Hubnity survives in different OS environments (macOS, Windows, Linux).

---

## 1. App Nap & Process Priority

| Item | Status | Notes |
|------|--------|-------|
| macOS App Nap | ⚠️ No protection | Emit loop (200ms) and sync (60s) can be throttled when app is backgrounded |
| Windows Background Model | ⚠️ No protection | Same risk |
| Timer accuracy | ✅ Acceptable | 200ms emit interval; drift is bounded by poll (2–5s) |

**Recommendation:** Consider `tauri-plugin-keepawake` or `tauri-plugin-nosleep` when timer is RUNNING to keep the emit loop "hot." Trade-off: higher battery use vs. more accurate time tracking. Current behavior is acceptable for most users.

---

## 2. Multiple App Instances ✅ FIXED

| Item | Status | Notes |
|------|--------|-------|
| Single instance lock | ✅ Implemented | `tauri-plugin-single-instance` added |
| Second launch behavior | ✅ Focus existing window | Show + set_focus on "main" window |
| SQLite corruption risk | ✅ Mitigated | Only one instance can run |
| Duplicate heartbeats | ✅ Mitigated | Same |

**Implementation:** `lib.rs` — `tauri_plugin_single_instance::init()` with callback that shows and focuses the main window when a second instance is launched.

---

## 3. Tray Icon & Notification Sync

| Item | Status | Notes |
|------|--------|-------|
| Tray menu items | Show, Hide, Quit | No Start/Pause/Stop in tray |
| Tray tooltip | ✅ Reactive | Updated by `Timer.tsx` `processState()` via `invoke('plugin:tray\|set_tooltip', ...)` |
| Global shortcuts | ❌ None | No global Start/Pause/Stop |
| Idle window | ✅ Synced | Resume/Stop buttons emit events; main window listens |

**Conclusion:** Tray is not an "island" — tooltip reflects TimerEngine state. Timer control is only in the main window and idle window. No changes needed if this is intentional.

---

## 4. Disk Full / Permission Denied ✅ FIXED

| Item | Status | Notes |
|------|--------|-------|
| DB error propagation | ✅ No panic | All DB ops use `Result` and `?` |
| Setup failure | ✅ Graceful | `create_dir_all` and `Database::new` return early with clear error |
| Runtime errors | ✅ Logged | `log_io_error_if_any()` logs DiskFull, ReadOnly, CannotOpen, SystemIoFailure |
| Error messages | ✅ Improved | `lib.rs` setup distinguishes PermissionDenied, StorageFull |

**Implementation:**
- `database.rs`: `log_io_error_if_any()` logs user-friendly messages for disk full / read-only / I/O errors.
- `lib.rs`: Setup uses `e.kind()` for `create_dir_all` to preserve `StorageFull` and `PermissionDenied`.

---

## 5. WebView Crash Recovery

| Item | Status | Notes |
|------|--------|-------|
| Rust timer | ✅ Outlives WebView | TimerEngine runs in Rust process |
| On reload | ✅ Re-sync | `Timer.tsx` listens to `timer-state-update` and polls `getTimerState()` every 2–5s |
| State source | ✅ Rust | `get_timer_state` returns Rust state |

**Conclusion:** When WebView reloads after crash, the frontend polls and receives events from Rust. Correct state is restored without resetting the timer.

---

## Summary of Code Changes

1. **Single instance** (`lib.rs`): Added `tauri-plugin-single-instance` with focus-on-second-launch callback.
2. **DB error handling** (`database.rs`): Added `log_io_error_if_any()` for disk full / read-only / I/O errors.
3. **Setup error handling** (`lib.rs`): Improved `create_dir_all` error messages for StorageFull and PermissionDenied.

---

## Optional Future Improvements

- **App Nap:** Add `tauri-plugin-keepawake` when timer is RUNNING (optional, battery trade-off).
- **Global shortcuts:** Add Start/Pause/Stop shortcuts if desired.
- **Tray timer control:** Add Pause/Resume to tray menu if desired.
