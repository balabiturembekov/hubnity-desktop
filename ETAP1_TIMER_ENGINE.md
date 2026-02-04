# ЭТАП 1: TIMER ENGINE - Завершен ✅

## Что сделано

### 1. Создан TimerEngine в Rust (`src-tauri/src/lib.rs`)

**Ключевые особенности:**
- ✅ Использует `std::time::Instant` (монотонное время, не зависит от системного времени)
- ✅ Поддерживает состояния: `STOPPED`, `RUNNING`, `PAUSED`
- ✅ Строгая валидация переходов (возвращает ошибки при невалидных переходах)
- ✅ Разделяет `accumulated_seconds` (накопленное за день) и `session_elapsed` (текущая сессия)
- ✅ Переживает свертывание окна (состояние в памяти Rust)

**Методы:**
- `start()` - начать трекинг из STOPPED
- `pause()` - приостановить из RUNNING
- `resume()` - возобновить из PAUSED
- `stop()` - остановить из RUNNING или PAUSED
- `get_state()` - получить текущее состояние
- `reset_day()` - сбросить накопленное время за день

### 2. Добавлены Tauri Commands

**Новые команды:**
- `start_timer` → вызывает `engine.start()`
- `pause_timer` → вызывает `engine.pause()`
- `resume_timer` → вызывает `engine.resume()`
- `stop_timer` → вызывает `engine.stop()`
- `get_timer_state` → вызывает `engine.get_state()`
- `reset_timer_day` → вызывает `engine.reset_day()`

### 3. Создан TypeScript API (`src/lib/timer-engine.ts`)

**Класс `TimerEngineAPI`:**
- Статические методы для вызова Rust команд
- Типизированные ответы (`TimerStateResponse`)
- Frontend НЕ считает время - только получает состояние

## Что можно удалить из Frontend

### ❌ УДАЛИТЬ из `src/store/useTrackerStore.ts`:

1. **Расчет времени:**
   ```typescript
   // УДАЛИТЬ:
   elapsedTime: number; // Frontend больше не считает время
   sessionStartTime: number | null; // Теперь в Rust
   dayStartTime: number | null; // Теперь в Rust
   
   // УДАЛИТЬ методы:
   updateElapsedTime: (seconds: number) => void; // Не нужен
   ```

2. **Логику расчета времени в `Timer.tsx`:**
   ```typescript
   // УДАЛИТЬ весь useEffect с расчетом времени
   // Вместо этого просто вызывать TimerEngineAPI.getState() каждую секунду
   ```

3. **localStorage для времени:**
   ```typescript
   // УДАЛИТЬ:
   localStorage.setItem('hubnity_dayStartTime', ...)
   localStorage.setItem('hubnity_accumulatedTime', ...)
   // Теперь все в Rust
   ```

### ✅ ОСТАВИТЬ в Frontend:

- `isTracking`, `isPaused` - можно оставить как UI cache (но источник истины - Rust)
- `currentTimeEntry` - для связи с API (но время считается в Rust)
- UI компоненты - только отображение

## Следующие шаги

### ШАГ 1: Интеграция Timer Engine в Frontend

1. В `Timer.tsx`:
   - Удалить весь расчет времени
   - Вызывать `TimerEngineAPI.getState()` каждую секунду
   - Отображать `elapsed_seconds` из ответа

2. В `useTrackerStore.ts`:
   - При `startTracking()` → вызывать `TimerEngineAPI.start()`
   - При `pauseTracking()` → вызывать `TimerEngineAPI.pause()`
   - При `resumeTracking()` → вызывать `TimerEngineAPI.resume()`
   - При `stopTracking()` → вызывать `TimerEngineAPI.stop()`

3. Удалить:
   - `updateElapsedTime`
   - `sessionStartTime`, `dayStartTime` из state
   - localStorage для времени

### ШАГ 2: Тестирование

1. Проверить, что время считается правильно
2. Проверить переходы состояний
3. Проверить, что время сохраняется при свертывании окна

## Важные замечания

⚠️ **Timer Engine НЕ интегрирован с API пока**
- Timer Engine считает время локально
- API calls (`startTimeEntry`, `pauseTimeEntry`) остаются отдельно
- На следующем этапе нужно синхронизировать Timer Engine с API

⚠️ **Sleep/Wake пока не обрабатывается**
- Это будет в ЭТАПЕ 4
- Сейчас Timer Engine может некорректно работать после sleep

## Статус

✅ **Timer Engine создан и готов к использованию**
⏳ **Ожидает интеграции в Frontend**
