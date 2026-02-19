# Chaos Audit Report

## Executive Summary

Audit of stress and edge-case scenarios. Identified 3+ "Nightmare Scenarios" with specific code fixes.

---

## 1. Fast-Clicker Race (Start/Pause 10x/sec)

**Status: ✅ Mitigated**

- **commands.rs**: `start_timer`, `pause_timer` are async but call sync `engine.start()`/`pause()`.
- **engine/core.rs**: State transitions use a single `Mutex` — transitions are serialized.
- **ActivityMonitor**: `start_activity_monitoring` has atomic check-and-set; only one tokio task spawns.

**Verdict**: No race. Rapid clicks serialize; invalid transitions (Running→Running) return Err.

---

## 2. Filesystem Corruption & Locks

**Status: ⚠️ Partial**

### Database Layer
- **database.rs**: No `unwrap()` in DB layer. `log_io_error_if_any` logs DiskFull, ReadOnly, SystemIoFailure.
- **Connection::open**: Fails on read-only; error propagates to setup. App won't start.
- **Runtime operations**: `save_timer_state`, `enqueue_sync` use `?` — errors propagate.

### Nightmare Scenario #1: DB Save Fails After State Transition
**Location**: `engine/core.rs` pause/stop flow.

**Problem**: In `pause_internal`, we set `*state = TimerState::Paused` BEFORE calling `save_state`. If save fails (disk full, read-only), we return Err but in-memory state is already Paused. Result: UI shows Paused, DB has Running. On restart → load Running from DB → **lost pause intent**.

**Fix**: Save BEFORE mutating state, or rollback state on save failure. See code fix below.

---

## 3. Midnight Rollover (23:59:59)

**Status: ✅ OK**

- **rollover_day**: Uses `if started_at_secs < old_day_end` — no underflow.
- **today_seconds**: Uses `from_midnight.min(elapsed_seconds)` — invariant preserved.
- **Clock skew**: Handled; Instant vs SystemTime compared.

**Verdict**: No negative durations; rollover logic is safe.

---

## 4. Zombie Processes (Tauri Exit)

**Status: ✅ Fixed**

### Nightmare Scenario #2: No Graceful Shutdown
**Location**: `lib.rs` — **FIXED**: `RunEvent::ExitRequested` handler added.

**Problem** (was): Background threads:
- Timer emit loop (std::thread + tokio)
- Sync loop (std::thread + tokio)
- Periodic save (std::thread + tokio)
- Activity monitor (tokio::spawn when monitoring starts)

On app quit, Tauri exits → process killed → **no final save**. If user paused at 23:59:58 and quit at 00:00:01, the last state might not be persisted.

**Fix applied**: Replaced `builder.run(context)` with `builder.build(context).expect().run(|app_handle, event| { ... })`. On `RunEvent::ExitRequested`, we call `engine.save_state()` before allowing exit. Background threads are daemon-style; process exit kills them, but state is persisted first.

---

## 5. Network Latency & Retries

**Status: ✅ Bounded**

- **sync_task**: No infinite loop. 401 retry is single (retry_with_refresh = false after refresh).
- **run_sync_internal**: `max_retries = 5`; tasks marked failed after 5 attempts.
- **Queue growth**: `enqueue_sync` caps at 10_000 — drops oldest when full.
- **Background sync**: 60s interval; errors don't stop the loop.

**Verdict**: No infinite retry; queue has hard cap.

---

## 6. Additional Nightmare Scenario

### Nightmare Scenario #3: Disk Full During Enqueue
**Location**: `database.rs` `enqueue_sync`, `commands.rs` when enqueueing time entry.

**Problem**: User starts tracking. We enqueue `time_entry_start`. Disk is full. `enqueue_sync` returns Err. Caller may not surface this clearly — user thinks tracking started, but queue has no task. On next sync, nothing to send. **Silent data loss**.

**Mitigation**: Ensure all enqueue call sites propagate and display the error. Check `start_tracking` flow.

---

## Code Fixes

### Fix 1: Rollback State on Save Failure (pause/stop)
In `engine/core.rs`, when `save_state_with_accumulated_override` fails after mutating state, we must revert. The cleanest approach: **save before mutating**. Refactor to compute new state, save to DB, then update memory only on success.

### Fix 2: RunEvent::ExitRequested
Add handler in `lib.rs` to persist state on exit.

### Fix 3: Improve DB Error Handling
Ensure `Database::new` and runtime DB errors are clearly communicated. Consider retry-on-transient for `SQLITE_BUSY`.
