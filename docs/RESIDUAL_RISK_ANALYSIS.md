# Residual Risk Analysis — Post-Audit

**Date:** Post State Desync / Race Conditions / Error Handling fixes  
**Scope:** Stability, Data Integrity, Security

---

## 1. Unimplemented Audit Points

| Issue | Status | Notes |
|-------|--------|-------|
| **CSP (Content-Security-Policy)** | ✅ FIXED | Strict CSP added in `tauri.conf.json`. |
| **Keychain for tokens** | ✅ FIXED | Uses `keyring` crate (macOS Keychain, Windows Credential Manager, Linux Secret Service). Fallback: random key in app_data_dir. |
| **Linux sleep behavior** | ⚠️ PARTIAL | Sleep detection is via time-gap in `get_state()` (works on all platforms). No native sleep/wake events on Linux; relies on next `get_state()` call. |
| **monitor.rs unwrap()** | ⚠️ LOW RISK | Only in `#[cfg(test)]` blocks. Production code uses `.lock()` without unwrap. |
| **commands.rs expect()** | ⚠️ LOW RISK | `screens.first().expect("BUG: screens is empty...")` — defensive, should never trigger. |
| **engine/db.rs unwrap()** | ⚠️ REVIEW | `saved_started_at.unwrap()` after `if let Some(...)` — safe pattern. |

---

## 2. Edge Cases in Sync

### 2.1 100+ items, slow/flapping network

- **Duplicate entries:** Mitigated by `idempotency_key` (hash of entity_type + payload). Server 400 "state-already-achieved" drops task. **Risk:** If `mark_task_sent()` fails after HTTP success, task stays pending and will retry → possible duplicate on server. Documented in sync/mod.rs:419.
- **Memory leak:** No. Batch size is adaptive (5–150). Tasks are processed in bounded batches. `by_type_synced` / `by_type_failed` HashMaps are small.
- **Queue growth:** Guard at 10,000 tasks; non-critical tasks dropped when full. Critical tasks evict oldest normal tasks.

### 2.2 Single-flight sync lock duration

**✅ FIXED:** Replaced `sync_lock` (Mutex) with `is_syncing` (AtomicBool). Network I/O runs outside any lock. Tasks are "claimed" via `claim_tasks_for_sync()` (updates `last_retry_at`) before network calls, so another sync won't pick the same tasks.

---

## 3. Data Integrity

### 3.1 Crash between `persist_time_entry_id` and store update

**Scenario:** Rust persists `last_active_time_entry_id` to SQLite, then app crashes before frontend updates `currentTimeEntry`.

- **On relaunch:** `loadActiveTimeEntry()` fetches from API. If offline, `get_last_time_entry_id` is used for resume/enqueue.
- **Conclusion:** Rust DB is source of truth for persisted id. Store is rebuilt from API + Timer Engine. No corruption; possible brief desync until `loadActiveTimeEntry` completes.

### 3.2 `rollover_day()` during Sleep Mode

- **Trigger:** `ensure_correct_day()` is called from `get_state()`, `start()`, `pause()`, `resume()`, `stop()`.
- **Sleep at midnight:** No call runs during sleep. On wake, next `get_state()` (e.g. from 200ms poll or user action) runs `ensure_correct_day()`.
- **Time source:** `Local::now()` uses system time, which advances correctly after wake.
- **Conclusion:** Rollover runs on first interaction after wake. No special handling needed.

---

## 4. Security Deep-Dive

### 4.1 Hardcoded secrets

| Location | Finding |
|----------|---------|
| `auth.rs:158` | `b"default-encryption-key-32-bytes!"` — fallback when `HUBNITY_ENCRYPTION_KEY` not set. **HIGH RISK** for production. |
| `e2e/helpers.ts` | `password?: string` default `'password123'` — test-only, acceptable. |
| `src/lib/api.ts` | `password` in login payload — normal, not hardcoded. |

### 4.2 Sentry and sensitive data

- **Sentry `beforeSend`:** Filters `token`, `password` in URL, headers, breadcrumbs, extra.
- **`setSentryContext('state_desync', {...})`:** Sends `storeState` (isTracking, isPaused) and `timerEngineState` (RUNNING/PAUSED/STOPPED). No tokens, no time entry IDs.
- **`captureException` from logger:** Passes `{ logger: { context, message } }`. No TimerState or SyncQueue payload.
- **Risk:** If `captureException` is ever called with full error object containing `TimerStateResponse` or sync payload, it could leak. Current usage does not pass such objects.

---

## 5. Database duplicate-check bug

**✅ FIXED:** Duplicate lookup now uses `idempotency_key` instead of `entity_type` + `payload` (which compared plaintext to encrypted).

---

## 6. Prioritized TO-DO for Next Sprint

### P0 — Critical (Stability & Security)

1. ~~**Replace default encryption key**~~ — ✅ DONE: keyring crate + fallback to random key in app_data_dir.
2. ~~**Shorten sync lock duration**~~ — ✅ DONE: AtomicBool single-flight, network I/O outside lock, claim_tasks_for_sync.

### P1 — High

3. ~~**Enable CSP**~~ — ✅ DONE: Strict CSP in tauri.conf.json.
4. ~~**Fix duplicate lookup in `enqueue_sync`**~~ — ✅ DONE: Uses idempotency_key.

### P2 — Medium

5. **Linux sleep** — Consider polling or platform-specific sleep detection if gaps are missed.
6. **Sentry context audit** — Ensure no `TimerStateResponse` or sync payload is ever passed to `captureException` or `setSentryContext` with sensitive fields.

### P3 — Low

7. **Replace `expect()` in commands.rs** — Use `match` or `ok_or_else` for screens.
8. **Document `mark_task_sent` failure** — Add runbook for "task remains pending after HTTP success" scenario.
