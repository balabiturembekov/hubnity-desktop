# Final Polish — Deep Scan Analysis

**Date:** Post P0/P1 implementation  
**Scope:** P2/P3 items, resource management, migration, edge cases

---

## 1. Unchecked P2/P3 Items (from Residual Risk)

| Item | Status | Notes |
|------|--------|-------|
| **P2: Linux sleep** | ✅ HANDLED | Time-gap detection in `get_state()` works on all platforms. `Instant` stops during suspend (Linux); `SystemTime` jumps on wake. Sleep detection triggers when `wall_elapsed > awake_elapsed` by threshold. |
| **P2: Sentry sanitization** | ⚠️ LOW RISK | `captureException` receives `{ logger: { context, message } }` only. No TimerState or SyncQueue payload passed. Error object's `message`/`stack` may contain generic strings. `setSentryContext('state_desync')` sends only `isTracking`, `isPaused`, `state` — no IDs. |
| **P3: Replace expect() in commands.rs** | ❌ PENDING | `screens.first().expect("BUG: screens is empty...")` — defensive, low risk. |
| **P3: Document mark_task_sent failure** | ❌ PENDING | Runbook for "task remains pending after HTTP success" not documented. |

---

## 2. Linux Sleep — Edge Cases

### Suspend-to-RAM (sleep)
- **Behavior:** Process stays in memory. On wake, `Instant` has not advanced (monotonic clock stops). `SystemTime` jumps.
- **Detection:** `wall_elapsed > awake_elapsed` by threshold → sleep detected → auto-pause.
- **Conclusion:** ✅ Handled.

### Suspend-to-Disk (hibernate)
- **Behavior:** System powers off. On resume, fresh boot — app process is gone.
- **Detection:** N/A. App restarts. `load_timer_state()` loads persisted state. Next `get_state()` runs normally.
- **Conclusion:** ✅ Handled (no in-process wake needed).

### Long sleep (>24h)
- **Behavior:** `wall_elapsed` could be huge. `displayed_elapsed` uses `wall_elapsed`; sleep detection would trigger first (gap > 5 min).
- **Conclusion:** ✅ Auto-pause before any overflow.

---

## 3. Sentry Sanitization — Leak Paths

### Path analysis
- **logger.error(ctx, msg, e):** Passes `e` to `captureException(error, { logger: { context, message }})`. Sentry receives the Error object. Custom properties on `e` could be serialized by Sentry SDK — depends on SDK config.
- **Current usage:** All `logger.error` calls pass `Error` or primitive. No call passes `TimerStateResponse` or sync payload as the error.
- **Rust errors:** Tauri invoke returns string errors. Frontend gets `"Decryption error: ..."` — no payload.
- **Risk:** If future code does `catch (e) { logger.error('X', 'msg', e); }` and `e` is an object with `timerState` property, it could leak. Recommend: add explicit allowlist in Sentry `beforeSend` for `logger` context keys.

### Recommendation
Add to Sentry `beforeSend`: recursively filter any `extra` or `context` keys matching `timerState`, `syncQueue`, `payload`, `currentTimeEntry`, `access_token`, `refresh_token`.

---

## 4. Resource Management

### SQLite connections
- **Model:** Single `Connection` in `Arc<Mutex<Connection>>`. Opened once at startup, never closed until process exit.
- **WAL mode:** Enabled. Allows one writer + concurrent readers. Mutex serializes all access.
- **Lock duration:** After refactor, lock held only for: `get_retry_tasks`, `claim_tasks_for_sync`, `mark_task_sent`, `update_sync_status`. Each is a short DB op. Network I/O is outside lock.
- **"Database is locked":** Unlikely. Mutex prevents concurrent access. WAL reduces lock contention. Operations are fast.
- **Conclusion:** ✅ No pooling needed. Single connection is correct for this use case.

### Thread safety (post AtomicBool refactor)
- **Database:** `std::sync::Mutex` — all DB access serialized. Safe.
- **SyncManager:** `is_syncing` AtomicBool — no lock. `sync_task` runs outside any shared lock. Each task is independent.
- **Logger (Rust):** `tracing` is thread-safe.
- **AuthManager:** `tokio::sync::RwLock` for tokens — async-safe.
- **Conclusion:** ✅ No deadlock or data race. Shared resources properly synchronized.

---

## 5. Keyring Migration — Existing Users

### Problem
Users who upgraded from pre-keyring version have:
- `sync_queue` payloads encrypted with **old default key** (`default-encryption-key-32-bytes!`)
- New app uses **keyring/fallback key** (different key)

### Current behavior
- **get_retry_tasks:** Calls `decrypt(encrypted_payload)`. Fails with new key → returns `Err(InvalidParameterName("Decryption error: ..."))` → whole sync fails.
- **get_last_time_entry_id_from_queue:** Uses `if let Ok(decrypted) = self.encryption.decrypt(&encrypted)` — skips on failure. No crash.
- **Result:** Sync is broken. App works otherwise. User sees "sync failed" but no crash/loop.

### Missing: graceful migration
- **Option A:** Try legacy key on first decrypt failure. If success, re-encrypt with new key, store in keyring. Complex.
- **Option B:** On decryption failure, mark task as `failed` with error "Encryption key changed — please clear sync queue and re-login". User can use "Retry failed" → would fail again. Need "Clear sync queue" in Settings.
- **Option C:** Document: "Upgrading from v0.1.26 or earlier: sync queue may need to be cleared. Go to Settings → Sync → Clear queue."
- **Recommendation:** Implement Option B + add "Clear sync queue" command. On first run after upgrade, if `get_retry_tasks` fails with Decryption error, show one-time toast: "Encryption upgraded. Old sync tasks cleared. You may need to re-login."

---

## 6. Logic Edge Cases

### Clock skew (user changes system time while RUNNING)
- **Time set backwards:** `wall_elapsed = saturating_sub(now, started_at)` → 0 or small. Display shows 0. No crash.
- **Time set forward:** `wall_elapsed` jumps. If jump > 5 min, sleep detection triggers → auto-pause. If jump < 5 min, displayed time jumps. Acceptable.
- **rollover_day:** Has explicit clock skew guards (lines 720–782). Uses `Instant` as source of truth when skew > 60s.
- **Conclusion:** ✅ Handled.

### Large batches — app closed mid-sync
- **claim_tasks_for_sync:** Sets `last_retry_at = now` for each task.
- **On next launch:** `get_retry_tasks` uses `last_retry_at + 5 <= now` (aggressive_retry). After 5 seconds, tasks are eligible again.
- **Status:** Tasks remain `pending`. No "stuck" or "claimed" status. They are retried on next sync.
- **Conclusion:** ✅ No stuck state. Tasks auto-retry after backoff.

---

## 7. Final Polish — Task List for 100% Production Readiness

### P2 — Medium (recommended this sprint)

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | **Keyring migration** | Medium | Add legacy key fallback in `TokenEncryption`: if keyring/fallback decrypt fails, try old default key. On success, re-encrypt with new key and store in keyring. Or: add "Clear sync queue" + one-time migration toast. |
| 2 | **Sentry extra sanitization** | Low | In `beforeSend`, filter keys: `timerState`, `syncQueue`, `payload`, `currentTimeEntry`, `access_token`, `refresh_token` from all event context/extra. |
| 3 | **Decryption failure handling** | Low | In `get_retry_tasks`, if decrypt fails for a row, skip that row (log warning) instead of failing entire batch. Prevents one corrupted row from blocking all sync. |

### P3 — Low (backlog)

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 4 | Replace `expect()` in commands.rs | Trivial | Use `screens.first().ok_or_else(|| "screens empty")` |
| 5 | Document mark_task_sent failure | Trivial | Add runbook to docs |
| 6 | Add "Clear sync queue" in Settings | Low | For users with decryption failures or stuck tasks |

### Optional — Hardening

| # | Task | Notes |
|---|------|-------|
| 7 | **is_syncing panic guard** | If `run_sync_internal` panics, `is_syncing` stays true. Add `std::panic::catch_unwind` or scopeguard to always reset. |
| 8 | **Stuck sync detection** | If `is_syncing` true for >300s, log warning and force reset. Requires storing `sync_started_at`. |

---

## 8. Summary

| Category | Status |
|----------|--------|
| Linux sleep | ✅ Handled |
| Sentry leak | ⚠️ Low risk; add sanitization |
| SQLite / DB lock | ✅ OK |
| Thread safety | ✅ OK |
| Keyring migration | ❌ **Critical gap** — existing users will have broken sync |
| Clock skew | ✅ Handled |
| Claimed tasks on close | ✅ Auto-retry |

**Top priority:** Keyring migration (P2 #1). Without it, all users upgrading from pre-keyring builds will have a broken sync queue.
