# Исправление: Objective-C Exception Crash

**Дата:** 2025-01-08  
**Проблема:** `fatal runtime error: Rust cannot catch foreign exceptions, aborting`

---

## Проблема

При вызове `get_active_window_info()` происходил crash приложения с ошибкой:
```
fatal runtime error: Rust cannot catch foreign exceptions, aborting
```

**Причина:**
- Objective-C exceptions не могут быть перехвачены через `panic::catch_unwind`
- Rust может перехватывать только Rust паники, но не foreign exceptions (Objective-C, C++, и т.д.)
- Вызовы Objective-C API через FFI могут выбрасывать exceptions, которые Rust не может обработать

---

## Решение

Временно отключена функция `get_active_window_info()` для предотвращения crashes.

**Изменения:**
1. ✅ Функция возвращает пустые данные сразу, без вызова Objective-C API
2. ✅ Добавлено предупреждение в логи
3. ✅ Код сохранен в комментариях для будущей реализации

**Код:**
```rust
#[tauri::command]
async fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    #[cfg(target_os = "macos")]
    {
        // ВРЕМЕННО ОТКЛЮЧЕНО: Objective-C exceptions не могут быть перехвачены
        warn!("[ACTIVE_WINDOW] Function temporarily disabled to prevent Objective-C exception crashes");
        
        return Ok(ActiveWindowInfo {
            app_name: None,
            window_title: None,
            url: None,
            domain: None,
        });
    }
}
```

---

## Альтернативные решения (для будущей реализации)

### Вариант 1: Objective-C @try/@catch через FFI

Создать Objective-C обертку с @try/@catch блоками:

```objective-c
// wrapper.m
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

NSDictionary* getActiveWindowInfoSafe() {
    @try {
        NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
        NSRunningApplication *app = [workspace frontmostApplication];
        
        if (!app) {
            return nil;
        }
        
        NSString *appName = [app localizedName];
        NSWindow *mainWindow = [app mainWindow];
        NSString *windowTitle = [mainWindow title];
        
        return @{
            @"app_name": appName ?: [NSNull null],
            @"window_title": windowTitle ?: [NSNull null],
        };
    }
    @catch (NSException *exception) {
        NSLog(@"Caught exception: %@", exception);
        return nil;
    }
}
```

Затем вызвать эту функцию из Rust через FFI.

### Вариант 2: Использование AppleScript

Использовать AppleScript для получения информации об активном окне:

```rust
use std::process::Command;

fn get_active_window_info_via_applescript() -> Result<ActiveWindowInfo, String> {
    let script = r#"
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            set frontWindow to name of first window of process frontApp
            return frontApp & "|" & frontWindow
        end tell
    "#;
    
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to run AppleScript: {}", e))?;
    
    // Parse output...
}
```

### Вариант 3: Использование Accessibility API через безопасные обертки

Использовать библиотеки, которые предоставляют безопасные обертки для Accessibility API, например:
- `accesskit` (Rust)
- `core-foundation` с правильной обработкой ошибок

---

## Текущее состояние

- ✅ Функция отключена и не вызывает crashes
- ✅ Приложение работает стабильно
- ✅ URL tracking временно не работает (возвращает пустые данные)
- ⏳ Требуется реализация безопасной версии через один из альтернативных подходов

---

## Рекомендации

1. **Краткосрочно:** Оставить функцию отключенной для стабильности
2. **Среднесрочно:** Реализовать вариант 2 (AppleScript) - самый простой и безопасный
3. **Долгосрочно:** Реализовать вариант 1 (Objective-C @try/@catch) для лучшей производительности

---

**Дата:** 2025-01-08  
**Статус:** ✅ Исправлено (временно отключено)
