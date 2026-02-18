# QA from Hell — 3 Failure Scenarios

Three edge-case scenarios that can break the app. Findings from code audit.

---

## 1. Timezone Change: NYC → London (5-hour jump)

**Scenario:** User starts timer in NYC (e.g. 8pm Jan 15 EST). Flies to London. Opens laptop at 1am Jan 16 GMT. Does day rollover and sync survive?

### Current Behavior

| Component | Behavior | Risk |
|-----------|----------|------|
| `ensure_correct_day()` | Uses `Local::now().date_naive()` — rollover is driven by **current** system timezone | ✅ OK if OS timezone updates on landing |
| `saved_day_local` | `day_start_ts` converted via `with_timezone(&Local)` | ✅ Correct for new timezone |
| `rollover_day()` | Adds `time_until_midnight` (old day), continues Running (Hubstaff-style) | ✅ Works for NYC→London (forward) |
| Sync queue | Payload uses `time_entry_id`; server uses ID, not day | ✅ Pause/Resume/Stop survive |

### Failure Modes

1. **OS timezone not updated yet**
   - User lands, opens laptop before WiFi/NTP updates timezone.
   - `Local::now()` still NYC → no rollover.
   - Sync sends tasks with “old” day; server may group by UTC.
   - **Impact:** Low — server usually stores UTC; display may be off until next poll.

2. **Backward rollover (London → NYC)**
   - User in London 1am Jan 16. Flies to NYC, lands 8pm Jan 15.
   - `saved_day_local` = Jan 16, `today_local` = Jan 15.
   - `rollover_day(Jan 16, Jan 15)` runs.
   - `old_day_end` = midnight Jan 15. `started_at_secs` (1am Jan 16 London) > `old_day_end` → `time_until_midnight` block skipped.
   - **Impact:** Accumulated time is kept; no obvious loss. Logic appears safe.

3. **`days_diff > 1` guard**
   - Jump of >1 day (e.g. long flight + manual date change) triggers warning but rollover still runs.
   - **Impact:** Possible incorrect `accumulated_seconds` if clock skew is large.

### Verdict

**Survives in normal cases.** Main risk: OS timezone lag on landing. Recommend testing with manual timezone change and delayed NTP.

---

## 2. Ghost Monitors: Disconnect During Screenshot

**Scenario:** User has external monitor. `take_screenshot` runs. Monitor is unplugged **between** `Screen::all()` and `screen.capture()`.

### Current Code Path

```rust
// commands.rs:462-508
let screens = screenshots::Screen::all()?;  // 1. Get list
let screen = screens.iter().find(|s| s.display_info.is_primary).or_else(|| screens.first())?;
let image = screen.capture()?;  // 2. Capture — monitor may be GONE here
```

### Failure Modes

1. **`screen.capture()` returns `Err`**
   - `screenshots` crate likely returns an error for disconnected display.
   - Handled via `map_err` → `Err` propagates to frontend.
   - **Impact:** User sees “Failed to capture screenshot” — no crash.

2. **`screen.capture()` panics**
   - Native APIs (e.g. CGDisplayCapture on macOS) can panic on invalid display.
   - Code runs in `spawn_blocking`; panic propagates to the task.
   - **Impact:** `invoke('take_screenshot')` rejects; frontend gets unhandled error. App does not crash.

3. **`capture()` returns `Ok` with invalid data**
   - Display gone but API returns a buffer.
   - `width == 0 || height == 0` → explicit check returns `Err`.
   - **Impact:** Handled.

4. **`image.rgba()` panics**
   - If buffer is invalid, `rgba()` could panic.
   - No `catch_unwind` around the blocking task.
   - **Impact:** Panic in worker thread; `invoke` fails; app may show error or behave oddly.

### Verdict

**Mostly safe.** Expected path (capture fails) is handled. Remaining risk: panic in `rgba()` or inside `screenshots` when display is disconnected. Recommend wrapping the blocking body in `std::panic::catch_unwind` and converting panic to `Err`.

---

## 3. Rapid Fire: Start–Pause–Resume–Stop–Start in &lt;1s

**Scenario:** User clicks Start → Pause → Resume → Stop → Start in under 1 second. Does the FSM or sync queue break?

### FSM (Rust Timer Engine)

- Each transition holds a mutex; calls are serialized.
- Valid transitions: Stopped→Running, Running→Paused, Paused→Running, Running→Stopped, Paused→Stopped.
- **Result:** Final state is Running. FSM behaves correctly.

### Frontend (`isLoading` guard)

- `startTracking`, `pauseTracking`, `resumeTracking`, `stopTracking` all:
  - Check `if (currentLoading) return;`
  - Set `isLoading = true` immediately.
- Operations are serialized; rapid clicks are effectively queued.
- **Result:** No parallel execution; FSM receives ordered transitions.

### Sync Queue — `cancel_opposite` Bug

**Flow:**

1. Start → enqueue `time_entry_start`
2. Pause → enqueue `time_entry_pause`, cancel opposite (`time_entry_resume`) — none yet
3. Resume → enqueue `time_entry_resume`, cancel opposite (`time_entry_pause`) — **cancels the pause from step 2**
4. Stop → enqueue `time_entry_stop`
5. Start → enqueue `time_entry_start`

**Queue after rapid fire:** `start`, `resume`, `stop`, `start` — **pause is cancelled.**

**Server view:**

- `start` → creates entry (RUNNING)
- `resume` → entry already RUNNING → 400 “state-already-achieved” or no-op
- `stop` → stops entry
- `start` → creates new entry

**Impact:** The pause in the middle is dropped. Server never receives it. Duration is recorded as if the user never paused; time is overcounted.

### Verdict

**FIXED:** Removed `cancel_opposite` for Pause/Resume pairs. Every state transition now reaches the server. Redundant Resume calls are acceptable; losing a Pause is not.

---

## Summary

| Scenario | Severity | Status |
|----------|----------|--------|
| Timezone NYC→London | Low | Survives; OS timezone lag is main risk |
| Ghost monitor during capture | Medium | Handled for `Err`; panic path not fully protected |
| Rapid fire Start–Pause–Resume–Stop–Start | High | Pause is cancelled; server gets wrong duration |
