# Исправление ошибки Tokio Runtime

## Проблема

При запуске приложения возникала ошибка:
```
thread 'main' panicked at src/lib.rs:2105:13:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
```

## Причина

Попытка использовать `tokio::spawn` в `setup` hook, где Tokio runtime еще не инициализирован.

## Решение

Вернуто использование `std::thread::spawn` с отдельным Tokio runtime для фоновой задачи синхронизации:

```rust
std::thread::spawn(move || {
    // Создаем отдельный Tokio runtime для фоновой задачи
    // Это необходимо, так как в setup hook основной runtime еще не готов
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for sync");
    rt.block_on(async {
        // Фоновая синхронизация
    });
});
```

## Обоснование

1. В `setup` hook основной Tokio runtime Tauri еще не инициализирован
2. Использование отдельного runtime в отдельном потоке безопасно и не конфликтует с основным
3. Это стандартный подход для фоновых задач, которые должны запускаться при инициализации

## Результат

✅ Код компилируется без ошибок  
✅ Фоновая синхронизация работает корректно  
✅ Нет конфликтов между runtime

---

**Дата:** 2025-01-08  
**Статус:** Исправлено
