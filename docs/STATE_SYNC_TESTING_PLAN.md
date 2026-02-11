# План тестирования синхронизации состояния

## Проблема
Многие баги рассинхронизации между Timer Engine (Rust) и Store (TypeScript) не были выявлены до продакшена.

## Решение: Добавить специализированные тесты

### 1. Интеграционные тесты состояния (E2E)

#### Тест: Быстрые последовательные действия
```typescript
test('rapid actions do not desync', async ({ page }) => {
  // Сценарий: пользователь быстро нажимает start → pause → resume → stop
  // Проверка: Timer Engine и Store всегда синхронизированы
});
```

#### Тест: Синхронизация после ошибок API
```typescript
test('state syncs after API error', async ({ page }) => {
  // Сценарий: API возвращает ошибку, но Timer Engine продолжает работать
  // Проверка: Store синхронизируется с Timer Engine, а не с API статусом
});
```

#### Тест: Параллельные операции
```typescript
test('concurrent operations maintain sync', async ({ page }) => {
  // Сценарий: syncTimerState вызывается во время pauseTracking
  // Проверка: isLoading защищает от race conditions
});
```

### 2. Property-based тесты (Rust)

Использовать библиотеку `proptest` для генерации случайных последовательностей действий:

```rust
#[proptest]
fn test_state_sync_property(
    actions: Vec<Action>, // Случайная последовательность start/pause/resume/stop
) {
    // Проверка: после любой последовательности действий состояние консистентно
}
```

### 3. Инварианты состояния

Добавить проверки инвариантов в runtime:

```typescript
// В useTrackerStore.ts
function assertStateInvariant() {
  const store = get();
  const timerState = await TimerEngineAPI.getState();
  
  // Инвариант 1: isTracking должен соответствовать Timer Engine
  const expectedTracking = timerState.state === 'RUNNING' || timerState.state === 'PAUSED';
  if (store.isTracking !== expectedTracking) {
    logger.error('STATE_SYNC', 'isTracking desync detected', {
      store: store.isTracking,
      timerEngine: expectedTracking,
    });
    // Автоматически синхронизировать
    set({ isTracking: expectedTracking });
  }
  
  // Инвариант 2: isPaused должен соответствовать Timer Engine
  const expectedPaused = timerState.state === 'PAUSED';
  if (store.isPaused !== expectedPaused) {
    logger.error('STATE_SYNC', 'isPaused desync detected', {
      store: store.isPaused,
      timerEngine: expectedPaused,
    });
    set({ isPaused: expectedPaused });
  }
}
```

### 4. Чеклист перед релизом

- [ ] Все E2E тесты проходят
- [ ] Property-based тесты прошли 1000+ итераций
- [ ] Инварианты состояния проверены в runtime
- [ ] Проведен ручной тест: быстрые действия пользователя
- [ ] Проведен тест: сбой сети во время операций
- [ ] Проведен тест: параллельные операции (sync + user action)
- [ ] Проведен аудит: все места, где используется store.isTracking/isPaused, проверяют Timer Engine

### 5. Мониторинг в продакшене

Добавить метрики для отслеживания рассинхронизации:

```typescript
// Отправлять в Sentry при обнаружении рассинхронизации
if (desyncDetected) {
  Sentry.captureMessage('State desync detected', {
    level: 'warning',
    extra: { storeState, timerEngineState },
  });
}
```
