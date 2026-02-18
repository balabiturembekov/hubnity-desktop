# Quiet Background Operation — Performance & Battery Analysis

**Role:** Performance & Systems Engineer  
**Context:** Logic is correct; optimize for battery life and CPU.

---

## 1. Polling Efficiency

### Current State

| Component | Interval | Behavior |
|-----------|----------|----------|
| **Rust emit loop** (`lib.rs`) | 200ms | Emits `timer-state-update` when RUNNING/PAUSED |
| **Frontend Timer.tsx** | 200ms | Listens to emit + **also polls** `get_timer_state` every 200ms |
| **Frontend sync** (`App.tsx`) | 30s | `syncTimerState` + `set_auth_tokens` + `sync_queue_now` |
| **Background sync** (Rust) | 60s | `sync_manager.sync_queue(5)` |
| **checkIdleStatus** | 10s | DOM-based idle check |
| **Heartbeat** | 45s | `sendHeartbeat` |

### Issues

1. **Redundant 200ms poll**: Timer.tsx both listens to `timer-state-update` AND polls `get_timer_state` every 200ms. The Rust emit already pushes state every 200ms when RUNNING/PAUSED. The poll is a fallback but runs unconditionally — doubling IPC/WebView work.

2. **No event-driven alternative**: The timer state changes only on explicit user actions (start/pause/resume/stop) or system events (sleep, idle). Rust could emit on state change instead of polling. Today: `get_state()` is called every 200ms; we could emit only when `TimerEngine` state actually changes.

### Recommendations

1. **Remove frontend poll when emit is active**: If we trust the Rust emit (it runs in a dedicated thread, never stops), the frontend can rely on `timer-state-update` only when RUNNING/PAUSED. Keep a slower poll (e.g. 2–5s) as a safety fallback for missed events.
2. **Event-driven Rust emit (future)**: Refactor `TimerEngine` to emit on state transition instead of a 200ms interval. Requires `Engine` to hold `AppHandle` or use a channel — larger refactor.
3. **Immediate win**: Increase frontend poll to 1000ms when RUNNING/PAUSED (emit remains 200ms for smooth elapsed display). Or remove poll entirely when we receive emits.

---

## 2. UI Throttling When Window Hidden/Minimized

### Current State

- **Rust emit loop**: Runs every 200ms regardless of window visibility.
- **Frontend**: No `document.visibilityState` or `window.isVisible` check. All intervals (poll, sync, heartbeat, idle check) run even when the app is in the tray.

### Tauri API

- `app.get_window("main").is_visible()` — Rust
- `document.visibilityState === 'hidden'` — WebView (may be unreliable on Windows per Tauri issue #10592)

### Strategy for UI Throttling

| When | Action |
|------|--------|
| **Window visible** | Normal: 200ms emit, 200ms poll (or 1s fallback), 30s sync, 10s idle check, 45s heartbeat |
| **Window hidden/minimized** | Throttle: 2s emit (or pause emit), 5s poll fallback, 60s sync, 30s idle check, 90s heartbeat |

**Implementation sketch:**

1. **Frontend**: Use `document.visibilityState` and `visibilitychange` to set a `isWindowVisible` flag in a store or context.
2. **Frontend**: Pass visibility to Rust via a Tauri command (e.g. `set_window_visibility(visible: bool)`) called on visibility change.
3. **Rust emit loop**: Accept `visibility: Arc<AtomicBool>`; when `false`, use 2s interval instead of 200ms, or skip emit when STOPPED.
4. **Frontend intervals**: Multiply `syncTimerState`, `checkIdleStatus`, `heartbeatInterval` by 2–3 when `document.hidden`.

**Simpler option**: Frontend only. When `document.hidden`, clear the 200ms poll and rely on a 2s poll. Sync/heartbeat/idle intervals already run in background; doubling them when hidden is a small change.

---

## 3. SQLite PRAGMA Settings

### Current State (`database.rs`)

```rust
conn.pragma_update(None, "journal_mode", "WAL")  // ✅ Set
// synchronous is NOT set — defaults to FULL
```

### Recommended Additions

```rust
// After journal_mode=WAL:
conn.pragma_update(None, "synchronous", "NORMAL")?;  // Safe with WAL; reduces fsync
conn.pragma_update(None, "cache_size", "-64000")?;    // 64MB cache (negative = KB)
conn.pragma_update(None, "temp_store", "MEMORY")?;     // Temp tables in RAM
conn.pragma_update(None, "mmap_size", "268435456")?;  // 256MB mmap (optional)
```

**Rationale:**

- **synchronous=NORMAL**: With WAL, NORMAL is safe and avoids fsync on every checkpoint. Significantly reduces disk I/O during sync bursts.
- **cache_size**: Larger cache reduces disk reads.
- **temp_store=MEMORY**: Temp tables (e.g. from complex queries) stay in RAM.

---

## 4. Screenshot Threading

### Current State

`take_screenshot` is `async fn` but performs blocking work on the Tokio runtime:

- `screenshots::Screen::all()` — may block
- `screen.capture()` — blocks (screen capture)
- `ImageBuffer::from_raw`, `resize` (Lanczos3), `ImageBuffer::from_fn`, `write_to` (JPEG) — all CPU-heavy, blocking

**Impact**: Blocks the Tokio worker thread for hundreds of ms. Can cause UI micro-stutters if the main thread shares work with the runtime.

### Fix

Wrap the entire capture + encode block in `tokio::task::spawn_blocking`:

```rust
#[tauri::command]
pub async fn take_screenshot(_time_entry_id: String) -> Result<Vec<u8>, String> {
    let result = tokio::task::spawn_blocking(|| {
        // All blocking work here: Screen::all(), capture(), resize, encode
        // ...
    })
    .await
    .map_err(|e| format!("Screenshot task panicked: {}", e))?;
    result
}
```

This keeps the Tokio runtime responsive and avoids blocking the main thread.

---

## 5. Memory Leaks

### SyncManager

- `db: Arc<Database>` — shared, bounded
- `auth_manager: Arc<AuthManager>` — shared, bounded
- `is_syncing: Arc<AtomicBool>` — single bool
- `client: reqwest::Client` — bounded

**No unbounded growth.**

### TimerEngine

- `state: Arc<Mutex<TimerState>>` — single enum
- `accumulated_seconds`, `day_start_timestamp`, `restored_from_running`, `last_transition_reason` — fixed-size

**No unbounded growth.**

### Database

- `conn: Arc<Mutex<Connection>>` — single connection
- `encryption` — fixed

**No unbounded growth.**

### AuthManager

- Token storage in keyring/fallback — bounded per user

**Conclusion**: No unbounded `Vec`, log buffers, or "processed tasks" lists. No memory leak risk identified.

---

## 6. Idle Monitor (system-idle-time)

### Current State

- **Poll interval**: 1 second (`tokio::time::sleep(Duration::from_secs(1))`)
- **Emit condition**: `idle < 5s` AND `last_emit >= 10s`
- **When user is away** (idle > 5 min): We never emit, but we still call `get_idle_time()` every second.

**Impact**: On macOS/Windows, `get_idle_time` can prevent deep C-states because it wakes the CPU every second.

### Adaptive Polling Strategy

| Idle duration | Poll interval | Rationale |
|---------------|--------------|-----------|
| &lt; 4 min | 1s | Need quick detection when user returns |
| 4–15 min | 5s | User likely away; reduce wake-ups |
| &gt; 15 min | 10s | User probably gone; minimal polling |

**Implementation sketch:**

```rust
let poll_interval = if idle_duration >= Duration::from_secs(15 * 60) {
    Duration::from_secs(10)
} else if idle_duration >= Duration::from_secs(4 * 60) {
    Duration::from_secs(5)
} else {
    Duration::from_secs(1)
};
tokio::time::sleep(poll_interval).await;
```

**Additional**: When `!is_monitoring` (tracking stopped), the loop exits — no polling. Good.

---

## 7. Summary: Priority Actions

| Priority | Action | Impact |
|---------|--------|--------|
| **P0** | Add `PRAGMA synchronous=NORMAL` (and optional cache/temp_store) | Lower disk I/O during sync |
| **P0** | Wrap `take_screenshot` blocking work in `spawn_blocking` | Avoid UI stutter |
| **P1** | Adaptive idle poll: 5s when idle 4–15 min, 10s when idle >15 min | Better battery, fewer wake-ups |
| **P1** | Frontend: throttle or stop 200ms poll when `document.hidden` | Less CPU/WebView when in tray |
| **P2** | Rust emit: check `window.is_visible()`, use 2s interval when hidden | Further CPU savings |
| **P2** | Remove redundant frontend poll when emit is received (or increase to 1s) | Simpler, less IPC |

---

## 8. Pre-flight Checklist (Battery/CPU)

- [ ] Add `synchronous=NORMAL` and optional PRAGMAs in `database.rs`
- [ ] Wrap screenshot capture + encode in `spawn_blocking`
- [ ] Implement adaptive idle poll (4 min / 15 min thresholds)
- [ ] Frontend: use `document.visibilityState` to throttle intervals when hidden
- [ ] (Optional) Rust: pass visibility to emit loop, slow to 2s when hidden
