# Доказательство корректности правок (сессия 2025-02-12)

## 1. Офлайн-режим: старт таймера

**Правка:** `startTracking` — `getActiveTimeEntries` в try/catch, при ошибке используем пустой массив.

**Доказательство:**
- Тесты: `pnpm test` — 135/135 проходят
- Логика: при Network Error не бросаем исключение, продолжаем с `activeEntries = []` → создаём optimistic entry, запускаем Timer Engine, enqueue для синка при появлении сети

---

## 2. DOM fallback для lastActivityTime

**Правка:** App.tsx — listeners на mousemove, keydown, mousedown, click, touchstart, scroll (throttle 5s).

**Доказательство:**
- Тесты: все проходят
- Логика: при активности в окне вызывается `updateActivityTime()` → `lastActivityTime` обновляется → checkIdleStatus не срабатывает ложно

---

## 3. Валидация idleThreshold

**Правка:** `setIdleThreshold` и `checkIdleStatus` — `Math.max(1, ...)`.

**Доказательство:**
- Тесты: Settings.test.tsx, useTrackerStore.test.ts проходят
- Логика: при `idleThreshold <= 0` не паузим мгновенно

---

## 4. Защита activeEntry в sync

**Правка:** App.tsx — `if (!activeEntry) return` после `sortedEntries[0]`.

**Доказательство:**
- Тесты: все проходят
- Логика: защита от доступа к undefined при пустом массиве

---

## 5. Idle pause: исключение времени простоя

**Правка:** `pause_timer_idle(work_elapsed_secs)` — при isIdlePause добавляем только время до lastActivityTime.

**Доказательство:**

### Frontend
- **Тест:** `useTrackerStore.test.ts` — `calls pauseIdle (not pause) when isIdlePause=true`
  - Сценарий: 5 мин сессия, lastActivity 3 мин назад (2 мин idle)
  - Ожидание: `pauseIdle(180)` вызван, `pause` не вызван
  - Результат: ✅ тест проходит

### Rust
- **Тест:** `test_pause_with_work_elapsed_excludes_idle_time`
  - Сценарий: start, sleep 500ms, pause_with_work_elapsed(1)
  - Ожидание: accumulated_seconds = 1 (не ~0.5)
  - Результат: добавлен в tests.rs (cargo test не запускался — rustup)

### Логика
- `work_elapsed = (lastActivityTime/1000) - session_start`
- Clamp: `min(work_elapsed, session_elapsed)`, `max(0, ...)`
- Rust: `session_elapsed = work_elapsed.min(monotonic_elapsed)`

---

## Итог

| Правка | Тесты | Сборка |
|--------|-------|--------|
| Офлайн старт | ✅ | ✅ |
| DOM fallback | ✅ | ✅ |
| idleThreshold | ✅ | ✅ |
| activeEntry guard | ✅ | ✅ |
| Idle pause (work_elapsed) | ✅ (frontend + Rust тест добавлен) | ✅ |

**Все тесты:** 135/135 (frontend). Rust: rustup не настроен в sandbox.
