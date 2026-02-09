# Hubnity

Tauri 2 + React + TypeScript time tracker.

## Запуск приложения

**Важно:** Запускайте приложение через **`pnpm tauri dev`** из корня проекта (не `cargo run` из `src-tauri`).

- `pnpm tauri dev` — поднимает фронт (Vite на localhost:1420) и открывает окно Tauri с React.
- `cargo run` из `src-tauri` — только Rust-бинарник; окно откроется на http://localhost:1420, но фронт не будет запущен → пустое окно.

```bash
pnpm install
pnpm tauri dev
```

Rust-команды (`cargo check`, `cargo test`) выполняйте из папки `src-tauri`.

## Сборка под Windows

**Рекомендуется:** собирать Windows-версию на самой Windows (или в CI, например GitHub Actions с `windows-latest`):

```bash
pnpm tauri build
# в диалоге выберите target Windows при необходимости
```

**Кросс-компиляция с macOS:** если в окружении задан `CFLAGS` (например с `-isysroot` под Xcode), сборка `libsqlite3-sys` для target Windows падает. Перед сборкой под Windows сбросьте CFLAGS:

```bash
CFLAGS= pnpm tauri build -- --target x86_64-pc-windows-msvc
```

Для одной проверки Rust без фронта:

```bash
cd src-tauri
CFLAGS= cargo build --target x86_64-pc-windows-msvc
```

Для полной кросс-компиляции под Windows с Mac может понадобиться Windows SDK / toolchain; если линковка не проходит — собирайте на Windows или в CI.

## CI (GitHub Actions)

В `.github/workflows/build.yml` настроена сборка под Windows, macOS (Intel и Apple Silicon) и Linux (Ubuntu).

- **Запуск:** при push в `main` или `release`, при открытии/обновлении PR в эти ветки, или вручную (Actions → Build Tauri → Run workflow).
- **При push:** создаётся черновик релиза (Draft release) с артефактами сборки.
- **При PR:** только сборка, релиз не создаётся.

В настройках репозитория: **Settings → Actions → General → Workflow permissions** выберите «Read and write permissions», чтобы действие могло создавать релизы.

## Уведомления об обновлениях

Приложение проверяет обновления с GitHub Releases и показывает уведомление и баннер «Установить», если доступна новая версия.

**Чтобы обновления работали (подпись артефактов):**

1. Сгенерируйте ключи подписи (один раз):
   ```bash
   pnpm tauri signer generate -w ~/.tauri/hubnity.key
   ```
2. В `src-tauri/tauri.conf.json` в `plugins.updater.pubkey` вставьте **содержимое** файла `~/.tauri/hubnity.key.pub` (не путь к файлу).
3. В GitHub: **Settings → Secrets and variables → Actions** добавьте секрет `TAURI_SIGNING_PRIVATE_KEY` — содержимое файла `~/.tauri/hubnity.key` (приватный ключ).
4. При сборке в CI Tauri подпишет артефакты; в релиз нужно загрузить файл `latest.json` (его генерирует сборка) вместе с установщиками. Если используете tauri-action, проверьте, что в релиз попадают артефакты обновления и `latest.json`.

Без подписи клиент не примет обновление (проверка подписи обязательна).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
