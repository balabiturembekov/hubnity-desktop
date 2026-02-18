# Release & Deployment Audit

Audit of update lifecycle, database migrations, asset paths, window management, and binary size for the first 10,000 users.

---

## 1. Updater Deadlock — Don't Kill App While Tracking ✅

**Risk:** If an update is downloaded while the Timer Engine is RUNNING, a force-restart would lose the last 10 minutes of unsynced time.

**Implementation:**

| Location | Guard |
|----------|-------|
| `App.tsx` (auto-install, ~5s timeout) | Before install: `getTimerState()` → if `state === 'RUNNING'`, skip install and show notification: "Update ready. Will install after you stop the timer." |
| `App.tsx` (`installUpdate` callback) | Before install: same check; if RUNNING, show "Please stop the timer first to install the update." and return |

**Strategy:** Update is deferred until the user stops the timer. No force-restart while tracking.

---

## 2. Database Migration (Schema Evolution) ✅

**Risk:** v0.2.0 adds a new column (e.g. `task_category`). Without versioning, the app could crash on existing DBs.

**Implementation:** `database.rs` — `run_migrations()` with `PRAGMA user_version`:

- `SCHEMA_VERSION = 5` (current)
- Migration 1: Create tables (time_entries, sync_queue, app_meta, indexes)
- Migration 2–5: Idempotent `ALTER TABLE ADD COLUMN` (error_message, priority, started_at, idempotency_key)
- Future v0.2.0: Add migration 6 for `task_category`, bump `SCHEMA_VERSION` to 6

**Pattern for new migrations:**

```rust
// In run_migrations():
if current < 6 {
    let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN task_category TEXT", []);
}
// ...
conn.pragma_update(None, "user_version", Self::SCHEMA_VERSION)?;
```

---

## 3. Asset Paths (Production vs Dev) ✅

**Risk:** Hardcoded relative paths (e.g. `./icons/32x32.png`) fail in compiled .exe/.app bundles.

**Implementation:** `commands.rs` — `get_tray_icon_path()`:

```rust
app.path().resolve("icons/32x32.png", BaseDirectory::Resource)
```

- Uses Tauri's `PathResolver::resolve()` for correct paths in dev and production
- `tauri.conf.json`: `"resources": ["icons/*"]` — icons bundled in resource directory

---

## 4. Z-Order & Focus (Window Management)

| Window | alwaysOnTop | Notes |
|--------|-------------|-------|
| IdleWindow | ✅ `true` | `tauri.conf.json` — user sees idle prompt over full-screen game/presentation |
| Update dialog | ⚠️ Main window | React banner in main window; if main window is hidden (e.g. in tray), user may not see it until they show the window |

**Recommendation:** Consider a small always-on-top "Update available" overlay or system notification when update is ready and main window is hidden.

---

## 5. Final Binary Size ✅

**Implementation:** `Cargo.toml` — `[profile.release]`:

```toml
[profile.release]
strip = true
lto = true
codegen-units = 1
panic = "abort"
```

- `strip = true` — removes debug symbols
- `lto = true` — link-time optimization
- `codegen-units = 1` — better optimization
- `panic = "abort"` — smaller binary, no unwinding

---

## Summary

| Item | Status |
|------|--------|
| Updater: no install while RUNNING | ✅ |
| SQLite migration versioning | ✅ |
| Tray icon production paths | ✅ |
| IdleWindow always on top | ✅ |
| Update dialog visibility when main hidden | ⚠️ Consider improvement |
| Release binary optimization | ✅ |
