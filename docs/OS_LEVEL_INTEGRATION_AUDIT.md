# OS-Level Integration Audit

## Executive Summary

Deep architectural analysis of System Events, Resource Management, and edge cases. Identified 2+ failure modes on wake/clock skew, WAL status, and deadlock analysis.

---

## 1. Time Traveler Bug (Clock Skew)

### Current Implementation
- **Elapsed during RUNNING**: Uses `Instant::now() - started_at_instant` (monotonic) — ✅ correct.
- **Saved to DB**: `started_at` stored as SystemTime (Unix ms) for calendar/display.
- **restore_state**: When loading "running" from DB, we compute `elapsed_since_save = now - started_at_secs` (both SystemTime).

### Failure Mode #1: Clock Set FORWARD Before Restart
**Scenario**: User runs timer 1 min, sets clock forward 1 hour, closes app. On restart:
- `now` = 11:00 (skewed), `started_at` = 10:00 (from save)
- `elapsed_since_save` = 3600s — we add 1 hour of **fake time** (real elapsed was ~60s).

**Mitigation**: `MAX_REASONABLE_ELAPSED = 24h` caps extreme cases. For forward skew < 24h, fake time can still be added. No perfect fix without storing "last save timestamp" or process uptime.

### Failure Mode #2: Clock Set BACK
**Scenario**: User runs timer, sets clock back 1 hour, restarts.
- `now < started_at_secs` — we correctly **skip** adding elapsed. ✅

### Recommendation
Document limitation. Consider storing `last_save_wall_secs` in app_meta on each save; on restore, cap `elapsed_since_save <= min(now - started_at, now - last_save_wall_secs + 60)`.

---

## 2. Lid Close Paradox (macOS/Windows Sleep)

### Current Implementation
- **Sleep detection**: `get_state()` compares `wall_elapsed_secs` vs `awake_elapsed_secs` (Instant on macOS, GetTickCount64 on Windows). Both freeze during sleep. ✅
- **Wake handling**: `setup_sleep_wake_handlers` runs **only on app startup** — no NSWorkspace/WindowEvent for wake during runtime.
- **ActivityMonitor**: Uses `get_idle_time()` (IOKit HIDIdleTime). After sleep, HIDIdleTime may **reset to 0** (user touched machine to wake).

### Failure Mode: False "Active" After Wake
**Scenario**: User in idle-pause, IdleWindow visible. Laptop sleeps 2h. On wake:
- `get_idle_time()` returns 0 (reset) → we emit `ACTIVITY_DETECTED` with idle_secs=0.
- Frontend may show "idle for 0 seconds" or treat user as "back" — confusing UX.

### Mitigation
- **Sleep detection** in `get_state()` already pauses timer on wake (within 1s of timer emit).
- **ActivityMonitor**: Add "wake grace period" — when engine detects sleep and pauses, emit `system-sleep-detected`; frontend/ActivityMonitor can suppress "active" for 30s.

---

## 3. Zombie Window (Multi-monitor / Virtual Desktops)

### Current Implementation
`show_idle_window` (commands.rs:810):
```rust
idle_window.show().map_err(...)?;
idle_window.center().map_err(...)?;
idle_window.set_focus().map_err(...)?;
```

✅ We call `show()`, `center()`, and `set_focus()` when Idle occurs. On macOS, `set_focus()` typically switches to the window's Space. On some systems (Linux virtual desktops), the window may remain on a different workspace — platform limitation.

---

## 4. SQLite "Database is Locked"

### Current Implementation
- Single `Arc<Mutex<Connection>>` — one writer at a time.
- **WAL mode**: ✅ Enabled in `Database::new()`:
  ```rust
  conn.pragma_update(None, "journal_mode", "WAL")
  ```

### SQL to Enable WAL (if needed manually or for recovery)
```sql
PRAGMA journal_mode=WAL;
```

WAL allows concurrent reads during writes and reduces "database is locked" under load. With one `Mutex<Connection>`, we serialize access — no lock contention between SyncManager and TimerEngine at the Rust level. SQLite WAL + single connection = safe.

---

## 5. Deadlock in tauri::State

### Analysis
- **Timer commands** (`start_timer`, `pause_timer`, etc.): Call `engine.start()`, `engine.pause()` — all **sync**. No `.await` while holding engine lock.
- **set_auth_tokens**: Uses `engine.reset_state()` (sync), then `auth_manager.set_tokens().await` — lock released before await. ✅
- **get_sync_status**: Uses `sync_manager.db` (sync), then `check_online_status().await` — no lock held across await. ✅

**Verdict**: No deadlock found. Engine and SyncManager methods are sync; async commands release locks before awaiting.

---

## 6. Summary: 2+ Failure Modes on Wake/Clock

| # | Scenario | Location | Impact |
|---|----------|----------|--------|
| 1 | Clock set **forward** before restart | engine/db.rs `restore_state` | Fake elapsed time added (up to 24h cap) |
| 2 | Wake from sleep: `get_idle_time()` resets to 0 | commands.rs ActivityMonitor | False "active" emit; confusing idle display |

---

## Recommended Fixes

1. **restore_state**: Cap `elapsed_since_save` using `last_save_wall_secs` if available (future).
2. **Wake re-validation**: Emit `system-sleep-detected` when `handle_system_sleep` runs; frontend can suppress activity for 30s.
3. **WAL**: Already enabled. Document SQL for manual recovery.
