# Состояние модулей src-tauri

Краткий аудит: что в порядке, что можно улучшить (не блокеры).

---

## В хорошем состоянии

| Модуль          | Состояние                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **auth.rs**     | AuthError + Display, AuthConfig + Default, один HTTP-клиент, refresh_token, set_tokens, get_access_token; без dead_code.                                        |
| **sync/mod.rs** | SyncError + Display, SyncConfig, один клиент, enqueue без токенов в payload, sync_task с AuthManager, refresh при 401; TokenRefreshResult только под cfg(test). |
| **engine/**     | FSM (Stopped/Running/Paused), ensure_correct_day, rollover_day, handle_system_sleep/wake, save_state; без allow(dead_code).                                     |
| **database.rs** | WAL, foreign_keys, lock_conn, TaskPriority из models; зависимости: auth (TokenEncryption), models.                                                              |
| **models.rs**   | Только данные и TaskPriority; без лишних зависимостей.                                                                                                          |
| **network.rs**  | check_online_status, extract_url/domain (macOS); изолирован.                                                                                                    |
| **commands.rs** | Все команды зарегистрированы в lib.rs; update_tray_time — no-op (обратная совместимость).                                                                       |
| **lib.rs**      | setup, manage(engine, sync_manager), invoke_handler полный, sleep/wake, periodic save, background sync.                                                         |

Линтер: ошибок нет.

---

## Мелкие улучшения (не обязательны)

### 1. Логирование: eprintln/println vs tracing

- **Сейчас:** в engine/core.rs, lib.rs, commands.rs часть сообщений через `eprintln!`/`println!` (SLEEP/WAKE, TIMER, SCREENSHOT, RUST/idle).
- **Идеал:** единообразно использовать `tracing` (info!, warn!, error!, debug!) для продакшена и фильтрации по RUST_LOG.
- **Действие:** по желанию заменить eprintln/println на tracing в engine, lib, commands (idle/screenshot).

### 2. commands.rs — отладочные println в idle

- **Сейчас:** в `update_idle_state` и `request_idle_state` есть `println!("[RUST] ...")`.
- **Идеал:** убрать или заменить на `tracing::debug!` для продакшена.
- **Действие:** заменить на debug! или удалить.

### 3. database.rs — allow(unused_mut)

- **Сейчас:** `#[allow(unused_mut)] let mut conn = Connection::open(...)`.
- **Идеал:** без allow; если mut не нужен — убрать.
- **Действие:** проверить, нужен ли mut для pragma_update; если нет — убрать mut и allow.

### 4. Типы ошибок в командах

- **Сейчас:** команды возвращают `Result<_, String>`; auth/sync внутри используют свои enum (AuthError, SyncError).
- **Идеал:** можно оставить как есть (String удобен для invoke) или позже продумать единый тип ошибки для API.
- **Действие:** опционально, не блокирует.

### 5. Тесты

- **Сейчас:** много `unwrap()`/`expect()` в тестах — нормально для тестов.
- **Идеал:** оставить как есть; при желании в критичных местах проверять ошибки явно.
- **Действие:** не требуется.

---

## Зависимости между модулями (Clean Architecture)

- **database** → auth (TokenEncryption), models. Не зависит от sync — ок.
- **sync** → auth, database, models. Команды вызывают sync — ок.
- **engine** → database (через with_db), не знает Tauri/sync — ок.
- **commands** → engine, sync, auth, monitor, network. Только слой входа — ок.
- **lib** — только сборка и manage/invoke — ок.

Циклов и грубых нарушений нет.

---

## Итог

- Модули в **хорошем состоянии**: архитектура, ошибки, конфиги, отсутствие dead_code, линтер чист.
- **Идеального** состояния нет в смысле «всё до блеска»: есть смесь eprintln/println и tracing, пара отладочных println в idle, один allow(unused_mut) в database. Это мелкие улучшения, не блокеры для продакшена или интеграции Tauri.

Если нужно, могу предложить конкретные патчи по пунктам 1–3 (логирование, println в idle, unused_mut).

---

## Аудит логики (2026-02)

Проверены условия, пороги и порядок операций — найдено и исправлено следующее.

### Исправлено

| Проблема         | Где                                 | Что было                                                                                                                                                                            | Что сделано                                                                                                                                                                                           |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Детекция сна** | engine/core.rs `get_state_internal` | «Сон» определялся как `session_elapsed > 15 мин` (монотонное время с начала сессии). При работе таймера >15 мин (например при съёмке скриншота) таймер ошибочно ставился на паузу.  | Сон определяется по разрыву wall-clock и monotonic: `wall_elapsed - session_elapsed >= 5 мин` (реальная приостановка системы).                                                                        |
| **Rollover дня** | engine/core.rs `rollover_day`       | После добавления `time_until_midnight` к `accumulated` и перевода в Stopped сразу обнуляли `accumulated` и вызывали `save_state()`. Итог за старый день ни разу не сохранялся в БД. | Перед обнулением добавлен вызов `save_state()` (day_start ещё старый → в БД пишется строка за старый день с итогом). Затем обнуление и обновление day_start, затем снова save_state() для нового дня. |

### Локальная полуночь для day rollover (2026-02)

- **Проблема:** В 00:10 по местному времени rollover не срабатывал, потому что «сегодня» определялось по **UTC**. В часовом поясе UTC+N в 00:10 местного времени в UTC ещё предыдущий день.
- **Исправление:** Смена дня считается по **локальной** полуночи: `Local::now().date_naive()` и `day_start_ts` переводятся в локальную дату. Сохранение/восстановление дня в engine/db.rs тоже переведено на локальную дату.

### Проверено, ошибок не найдено

- **Sync:** `get_retry_tasks` — при `last_retry_at IS NULL` задачи попадают в выборку (первая попытка).
- **Idle:** `idleTime >= idleThreshold` (в минутах) — пауза при достижении порога, логика корректна.
- **Screenshot:** при паузе/idle не планируем следующий снимок; после resume `checkAndStartScreenshots` по подписке на store и интервалу 5 с снова запускает планирование.
- **URL tracking / App.tsx:** в cleanup выставляется `isCleanedUp = true`, интервалы очищаются — гонки нет.
- **Rust state:** сериализация в API отдаёт `RUNNING`/`PAUSED`/`STOPPED`, фронт сравнивает с теми же строками — согласованно.
