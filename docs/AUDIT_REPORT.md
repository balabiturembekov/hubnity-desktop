# Аудит приложения Hubnity — потенциальные проблемы

Дата: 2025-02-10

## 1. Уже исправлено (сессия 2025-02-10)

- **Изоляция пользователей:** `getActiveTimeEntries` — фильтр по `userId` добавлен во все места (App.tsx syncTimerState, useTrackerStore: loadActiveTimeEntry, startTracking, pauseTracking, stopTracking).
- **Fallback на чужую запись:** Удалён `activeEntries[0]` fallback в startTracking (строки 842–844, 884–900).

---

## 2. Низкий приоритет (edge cases)

### 2.1 Settings: NaN при get_sleep_gap_threshold_minutes

**Файл:** `src/components/Settings.tsx`

**Проблема:** Если `invoke('get_sleep_gap_threshold_minutes')` вернёт нечисловое значение или произойдёт неожиданная ошибка, `sleepGapThreshold` может стать NaN. React выдаёт: "Received NaN for the `value` attribute".

**Рекомендация:** Добавить fallback при загрузке:
```typescript
.then((m) => {
  if (isMountedRef.current) {
    const val = Number.isFinite(m) ? Math.max(1, Math.min(120, m)) : 5;
    setSleepGapThreshold(val);
    setLoadedSleepGap(val);
  }
})
```

### 2.2 Settings: user.company может быть undefined

**Файл:** `src/components/Settings.tsx`, строка 278

**Проблема:** `user.company.name` — при отсутствии `company` будет runtime error.

**Рекомендация:** `user.company?.name ?? '—'`

---

## 3. Архитектура (без изменений)

### 3.1 Синхронизация Store ↔ Timer Engine

- **assertStateInvariant** вызывается каждые 5 с, исправляет рассинхрон `isTracking`/`isPaused`.
- **updateTimerState** в Timer.tsx — poll 200ms + push от Rust.
- **Источник истины:** Timer Engine (Rust). Store — кэш для UI.

### 3.2 check_online_status

**Файл:** `src-tauri/src/network.rs`

Использует cloudflare.com и google.com как fallback. Подход корректен для проверки доступности интернета без зависимости от API.

---

## 4. Потенциальные race conditions (уже защищены)

- **isLoading** — блокирует параллельные вызовы start/pause/stop.
- **syncTimerState** — пропускает синк при `isLoading`, принудительное восстановление через 60 с.
- **checkIdleStatus** — `isIdleCheckPausing` предотвращает повторные паузы.

---

## 5. Логика (проверено)

| Сценарий | Статус |
|----------|--------|
| Start → API ошибка | Таймер продолжает, temp-запись, "Will sync when online" |
| Load active entry | Фильтр по userId, восстановление из engine при offline |
| Sync с сервера | Фильтр по userId, не останавливает при localTimerStartTime < 2 min |
| Resume после wake | restored_from_running, ручной resume |
| Смена пользователя | clear_user_data + reset_state |

---

## 6. Рекомендуемые правки

1. **Settings:** fallback при загрузке sleep gap (п. 2.1).
2. **Settings:** `user.company?.name` (п. 2.2).

Остальное — в пределах нормы или уже исправлено.
