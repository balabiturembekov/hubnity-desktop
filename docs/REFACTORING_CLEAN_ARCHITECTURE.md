# План рефакторинга под Clean Architecture

Порядок шагов: от наименее рискованных к более крупным. После каждого шага — прогон тестов и сборка.

---

## Фаза 1: Backend — развязать database → sync

### Шаг 1.1: Перенести `TaskPriority` в `models`

**Цель:** Убрать зависимость `database` от `sync`.

1. В **`src-tauri/src/models.rs`** добавить:
   - enum `TaskPriority` (скопировать из `sync/mod.rs`: варианты Critical, High, Normal и `impl TaskPriority { fn from_entity_type(entity_type: &str) -> Self { ... } }`).

2. В **`src-tauri/src/sync/mod.rs`**:
   - Удалить enum `TaskPriority` и его `impl`.
   - Добавить: `use crate::models::TaskPriority;` (или `pub use crate::models::TaskPriority` если нужно реэкспортировать).

3. В **`src-tauri/src/lib.rs`**:
   - Заменить `use crate::sync::TaskPriority` на `pub use crate::models::TaskPriority` (или оставить реэкспорт из sync, если там оставить `pub use crate::models::TaskPriority`).

4. В **`src-tauri/src/database.rs`**:
   - Заменить `use crate::TaskPriority` на `use crate::models::TaskPriority` (или `crate::TaskPriority` если реэкспорт остаётся в lib).

5. Проверить: `cargo build`, тесты Rust.

**Итог:** `database` больше не зависит от `sync`. `TaskPriority` — общая модель в `models`.

---

## Фаза 2: Backend — вынести утилиты из `lib.rs`

### Шаг 2.1: Модуль `network` (или `utils`) для проверки сети и URL

**Цель:** Убрать из корня `lib.rs` логику reqwest и парсинга URL.

1. Создать **`src-tauri/src/network.rs`** (или `utils.rs`):
   - Перенести `check_online_status()` из `lib.rs`.
   - Сигнатуры и поведение не менять.

2. В **`src-tauri/src/lib.rs`**:
   - Добавить `mod network;` (или `mod utils;`).
   - Удалить тело `check_online_status`, оставить вызов в `commands` через `crate::network::check_online_status` (или реэкспорт `pub use crate::network::check_online_status` в lib и оставить в commands `crate::check_online_status`).

3. Проверить: `cargo build`, тесты.

### Шаг 2.2: Вынести `extract_url_from_title` и `extract_domain`

**Цель:** Убрать macOS-специфичный парсинг из корня lib.

1. В **`src-tauri/src/network.rs`** (или создать **`src-tauri/src/macros_url.rs`** только для macOS):
   - Перенести `extract_url_from_title` и `extract_domain` из `lib.rs`.
   - Обернуть в `#[cfg(target_os = "macos")]` если выносите в отдельный модуль.

2. В **`src-tauri/src/lib.rs`**:
   - Удалить эти функции, добавить реэкспорт из нового модуля при необходимости.

3. В **`src-tauri/src/commands.rs`**:
   - Заменить `crate::extract_url_from_title` на `crate::network::extract_url_from_title` (или оставить через реэкспорт в lib).

4. Проверить: `cargo build` (в т.ч. на macOS если возможно).

**Итог:** В `lib.rs` остаются только сборка приложения, регистрация команд и реэкспорты. Сетевая/URL логика — в отдельном модуле.

---

## Фаза 3: Frontend — разорвать цикл useAuthStore ↔ useTrackerStore

### Шаг 3.1: Общий «текущий пользователь» без цикла

**Цель:** Tracker store не импортирует Auth store; оба опираются на один источник правды.

1. Создать **`src/lib/current-user.ts`**:
   - Переменная (или простой объект) + функции:
     - `setCurrentUser(user: LoginResponse['user'] | null): void`
     - `getCurrentUser(): LoginResponse['user'] | null`
   - Тип пользователя импортировать из `api` (или из общего типа).

2. В **`src/store/useAuthStore.ts`**:
   - В `login` после `set({ user, ... })` вызвать `setCurrentUser(response.user)`.
   - В `logout` в начале вызвать `setCurrentUser(null)`.
   - Удалить `import { useTrackerStore } from './useTrackerStore'`.
   - В `logout` удалить вызов `await useTrackerStore.getState().reset()`.

3. В **`src/store/useTrackerStore.ts`**:
   - Удалить `import { useAuthStore } from './useAuthStore'`.
   - Везде, где было `useAuthStore.getState().user`, заменить на `getCurrentUser()` из `lib/current-user.ts`.

4. В **месте вызова logout** (например, **`src/components/Settings.tsx`** или где кнопка «Выйти»):
   - После вызова `logout()` из `useAuthStore` вызывать `useTrackerStore.getState().reset()` (импорт useTrackerStore только в этом компоненте/странице).

5. Проверить: логин, выход, старт трекинга без авторизации должен по-прежнему показывать ошибку. Прогон тестов и E2E при необходимости.

**Итог:** Нет цикла между сторами; «текущий пользователь» — один общий модуль; сброс трекера при выходе остаётся в UI.

---

## Фаза 4: Frontend — UI только через store (не напрямую api / timer-engine)

**Цель:** Компоненты не импортируют `api` и `TimerEngineAPI` для бизнес-сценариев; только store (и при необходимости явные хуки).

### Шаг 4.1: App.tsx

1. В **`src/App.tsx`** найти все вызовы `api.*` и `TimerEngineAPI.*`.
2. Перенести логику в методы store (или в один общий хук, который использует store + Tauri).
3. В компоненте оставить только вызовы store (и при необходимости `invoke` только для восстановления токенов в Rust, если это не бизнес-сценарий).
4. Удалить импорты `api` и `TimerEngineAPI` из App.tsx, если они больше не нужны.

### Шаг 4.2: Timer.tsx

1. В **`src/components/Timer.tsx`** убрать прямой импорт `TimerEngineAPI` и `TimerStateResponse`.
2. Данные для отображения (состояние таймера, elapsed и т.д.) получать из store: либо store держит копию из Rust (обновляемую по событиям), либо один хук типа `useTimerState()` вызывает `TimerEngineAPI` и кладёт результат в store / возвращает из store.
3. Действия (старт/пауза/стоп) уже через store; убедиться, что компонент только вызывает store, а не `TimerEngineAPI` напрямую.

### Шаг 4.3: ScreenshotsView.tsx

1. В **`src/components/ScreenshotsView.tsx`** убрать импорт `api`.
2. Загрузку списка скриншотов (и при необходимости загрузку файла) перенести в store: например, `useTrackerStore.getState().loadScreenshots()` или отдельный `useScreenshotsStore`, который внутри вызывает `api`.
3. Компонент только вызывает store и отображает данные из store.

**Итог:** UI зависит только от store (и общих lib: logger, utils); адаптеры (api, timer-engine) использует только store.

---

## Фаза 5 (опционально): Backend — engine не зависит от конкретной БД

**Цель:** Домен (engine) зависит от trait персистенции, а не от `Database`.

### Шаг 5.1: Trait персистенции в engine

1. В **`src-tauri/src/engine/`** (например, в `mod.rs` или `persistence.rs`) описать trait:
   - Например: `pub trait TimerPersistence { fn save(...); fn load(...); }` с нужными сигнатурами под текущие `save_state` / `load_state`.
2. В **`engine/db.rs`** и **`engine/mod.rs`**:
   - `TimerEngine` хранит `Option<Arc<dyn TimerPersistence>>` вместо `Option<Arc<Database>>`.
   - Логику сохранения/загрузки оставить в `engine/db.rs`, но вызывать через trait.

### Шаг 5.2: Database реализует trait

1. В **`src-tauri/src/database.rs`** реализовать `impl TimerPersistence for Database` (методы перенести/адаптировать из текущего `engine/db.rs`).
2. В **`src-tauri/src/lib.rs`** при создании `TimerEngine` передавать `Arc<Database>` как `Arc<dyn TimerPersistence>`.
3. Убрать из **`engine/mod.rs`** и **`engine/db.rs`** все `use crate::Database`; engine знает только про `TimerPersistence`.

**Итог:** Домен engine не зависит от SQLite и конкретного типа Database; зависимость направлена внутрь (adapter реализует интерфейс домена).

---

## Порядок выполнения

| Фаза | Шаги | Риск |
|------|------|------|
| 1 | 1.1 TaskPriority → models | Низкий |
| 2 | 2.1 check_online_status; 2.2 extract_url | Низкий |
| 3 | 3.1 current-user, убрать цикл store | Средний |
| 4 | 4.1–4.3 UI только через store | Средний |
| 5 | 5.1–5.2 TimerPersistence trait | Выше (много касаний) |

Рекомендация: сделать фазы 1–3, прогнать тесты и E2E, затем 4, затем при необходимости 5.
