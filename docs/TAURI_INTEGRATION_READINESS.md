# Готовность к интеграции Tauri

Чеклист для релиза/интеграции приложения Hubnity как Tauri 2 desktop app.

---

## ✅ Уже готово

| Элемент | Статус |
|--------|--------|
| **Tauri 2** | `tauri = "2"`, `tauri-build`, `tauri-plugin-opener`, `tauri-plugin-notification` в Cargo.toml |
| **Конфиг** | `tauri.conf.json`: productName, identifier, build (beforeDevCommand, beforeBuildCommand, frontendDist), два окна (main, idle), security.csp, bundle (icons, targets, macOS) |
| **Сборка** | `beforeBuildCommand: "pnpm build"`, `frontendDist: "../dist"` — фронт собирается до билда Tauri |
| **Окна** | main (335×840), idle (скрытое, alwaysOnTop, для окна «Простой») |
| **Иконки** | icons/ с 32x32, 128x128, @2x, .icns, .ico |
| **Capabilities** | default (main: core, opener, notification), idle (core, window, event, notification) |
| **Invoke handler** | Все команды зарегистрированы в `lib.rs` (sync, timer, activity, screenshot, idle, auth, tray time, log, notification) |
| **Плагины** | opener, notification подключены и указаны в default capability |

---

## ⚠️ Проверить / доработать

### 1. Tray (системный трей)

- **Сейчас:** фронт вызывает `invoke('plugin:tray|new', ...)` и `plugin:tray|set_tooltip`, но в `Cargo.toml` у Tauri **нет** feature `tray-icon`: `tauri = { version = "2", features = [] }`.
- **Итог:** вызовы трея могут не работать или требовать другой API.
- **Что сделать:**  
  - Либо включить трей: в `src-tauri/Cargo.toml` задать  
    `tauri = { version = "2", features = ["tray-icon"] }`,  
    и при необходимости перейти на [Tauri 2 System Tray API](https://v2.tauri.app/learn/system-tray) (в т.ч. с фронта).  
  - Либо явно оставить трей опциональным: при ошибке создания трея не падать (как сейчас в коде) и не считать это блокером интеграции.

### 2. Разрешения для кастомных команд (capabilities)

- В **default** сейчас только: `core:default`, `opener:default`, `notification:default`.
- В Tauri 2 доступ к кастомным командам (invoke) определяется capability: команда разрешена, только если у окна есть соответствующее разрешение.
- **Что сделать:**  
  - Запустить приложение и пройти сценарии: старт/пауза/стоп таймера, синк, скриншоты, idle, логин, уведомления.  
  - Если какая-то команда будет запрещена (ошибка в консоли/логах), добавить в `capabilities/default.json` в `permissions` нужные разрешения (например `allow-<command_name>` после генерации схем в `gen/`).  
  - При необходимости один раз выполнить `pnpm tauri build` и посмотреть сгенерированные разрешения в `src-tauri/gen/`.

### 3. Билд и запуск

- Убедиться, что собирается и фронт, и бэкенд:  
  `pnpm install && pnpm tauri build`  
  и что приложение запускается:  
  `pnpm tauri run`.
- Проверить упаковку под нужные цели (macOS .app / Windows / Linux) в `tauri.conf.json` → `bundle.targets`.

### 4. Подписание и дистрибуция (macOS)

- В конфиге: `signingIdentity: null`, `entitlements: null`.
- Для распространения вне разработки понадобится: код-подпись (signingIdentity) и при необходимости entitlements (например доступ к сети, скриншотам).
- Сейчас достаточно для локальной сборки и тестов; перед выкладкой в Store или раздачей бинарников — настроить подписание.

### 5. CSP (Content Security Policy)

- В конфиге: `"security": { "csp": null }`.
- Для продакшена часто задают явный CSP (ограничение скриптов, стилей, подключений). При появлении требований по безопасности — добавить политику в `tauri.conf.json`.

---

## Краткий чеклист перед релизом

1. [ ] Включить `tray-icon` в Tauri и проверить трей **или** зафиксировать, что трей опционален.
2. [ ] Пройти все сценарии приложения; при отказе invoke — добавить нужные разрешения в capabilities.
3. [ ] Выполнить `pnpm tauri build` и убедиться, что артефакты создаются.
4. [ ] (Опционально) Настроить подписание и entitlements для macOS.
5. [ ] (Опционально) Задать CSP в `tauri.conf.json`.

---

## Итог

**Для разработки и внутренней интеграции** текущая конфигурация Tauri уже пригодна: конфиг, окна, команды, плагины и сборка настроены.

**Для публичной интеграции/релиза** стоит: включить или явно отключить трей, проверить capabilities по факту вызовов invoke и при необходимости добавить подписание и CSP.
