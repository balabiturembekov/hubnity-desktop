# Offline Work & Log Integrity — Deep Edge Case Analysis

Audit for long-term survival and ease of support.

---

## 1. Multi-Day Offline Session

### Chronological Sync Order ✅ CONFIRMED

**Location:** `database.rs` → `get_retry_tasks()`

```sql
ORDER BY priority ASC, created_at ASC
```

- **Priority:** Critical (0) → High (1) → Normal (2)
  - `time_entry_start`, `time_entry_stop` = Critical
  - `time_entry_pause`, `time_entry_resume` = High
  - `screenshot`, `activity` = Normal
- **Within each priority:** `created_at ASC` → chronological order

**Result:** Tasks are uploaded in correct timeline order. Start/stop first, then pause/resume, then screenshots/activities.

### Screenshot Upload & Request Timeout

| Item | Status | Notes |
|------|--------|-------|
| HTTP timeout | 120 sec | `SyncConfig::http_timeout_secs` |
| Per-request | Sequential | One task at a time in sync loop |
| On timeout | Marked failed | Exponential backoff retry (5s when online) |
| Large backlog | Handled | Batch size adapts (up to 150); each request has 120s |

**Conclusion:** Request timeout is handled by marking the task as failed and retrying later. No crash. For 100MB+ backlog, uploads proceed sequentially; slow connections may need multiple sync cycles.

---

## 2. Database Corruption Recovery ✅ IMPLEMENTED

### Strategy

1. **On startup:** `PRAGMA integrity_check` in `Database::new()`
2. **If corrupt:** Return error with "corruption" in message
3. **In `lib.rs` setup:** If corruption detected, rename `hubnity.db` → `hubnity.db.corrupted.{timestamp}`
4. **Retry:** Create fresh DB
5. **Notify:** Emit `db-recovered-from-corruption` → frontend shows notification

### Implementation

- **`database.rs`:** Integrity check after `Connection::open`, before `init_schema`
- **`lib.rs`:** Recovery block in setup; only runs when error contains "corruption" or "integrity" and file exists
- **Frontend:** `App.tsx` listens for `db-recovered-from-corruption` and shows notification

### Behavior

- **No crash loop:** App starts with fresh DB or exits with clear error
- **Recovery:** Corrupted DB backed up; user can inspect or send for debugging
- **Data loss:** Pending sync queue and timer state are lost; user is notified

---

## 3. Log File Rotation

### Current State

| Item | Status | Notes |
|------|--------|-------|
| Rust logs | `tracing_subscriber::fmt()` | Writes to **stderr** |
| File output | None | No file logging by default |
| Rotation | N/A | No file = no rotation needed |

**Conclusion:** Rust logs go to stderr. In dev (terminal) they appear. In packaged app, stdout/stderr may go to system log or nowhere. No rotation needed because there is no log file.

### Optional: File Logging with Rotation

If you want persistent logs for support:

1. Add `tracing-appender` crate
2. Use `RollingFileAppender` with daily rotation and `max_log_files`:

```rust
// Example (not in codebase yet)
let file_appender = tracing_appender::rolling::Builder::new()
    .rotation(tracing_appender::rolling::Rotation::DAILY)
    .max_log_files(3)
    .build("logs/hubnity")
    .expect("Failed to create log file");

let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
tracing_subscriber::fmt()
    .with_writer(non_blocking.and(std::io::stderr))
    .with_env_filter(...)
    .init();
```

**Recommendation:** Keep current behavior (stderr only) unless you need file logs for debugging. If you add file logging, use rotation and keep at most 3–5 files.

---

## 4. Version Skew in Sync ✅ IMPLEMENTED

### X-App-Version Header

**Location:** `sync/mod.rs` → `send_time_entry_request()`, `send_screenshot_request()`

| Item | Status | Notes |
|------|--------|-------|
| Header | `X-App-Version` | Sent on every sync request |
| Value | `app.package_info().version` | From Tauri config |
| Time entries | ✅ | All time_entry_* requests |
| Screenshots | ✅ | All screenshot requests |

**Result:** Backend can log `X-App-Version` to debug version skew and API compatibility issues.

---

## Summary of Code Changes

1. **DB integrity:** `PRAGMA integrity_check` in `Database::new()`
2. **DB recovery:** Auto-recovery in `lib.rs` setup (rename + retry + notify)
3. **Frontend:** Listener for `db-recovered-from-corruption` with notification
4. **Sync:** `X-App-Version` header on all sync requests

---

## Checklist

| Item | Status |
|------|--------|
| Chronological sync order | ✅ `ORDER BY priority ASC, created_at ASC` |
| Screenshot timeout handling | ✅ Retry with exponential backoff |
| DB integrity check | ✅ `PRAGMA integrity_check` on startup |
| DB corruption recovery | ✅ Rename, fresh DB, notify user |
| Log rotation | N/A (no file output) |
| App version in sync | ✅ `X-App-Version` header |
