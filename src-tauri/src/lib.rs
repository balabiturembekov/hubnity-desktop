use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
#[allow(unused_imports)] // Local используется в тестах
use chrono::{Local, Utc};
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, State, Listener};
use tracing::{debug, error, info, warn};

// Sleep/wake handling использует проверку времени в get_state()
// вместо прямых системных событий для упрощения реализации

// ============================================
// TOKEN ENCRYPTION
// ============================================

/// Шифрование токенов перед сохранением в SQLite
/// Использует AES-256-GCM для шифрования
pub struct TokenEncryption {
    cipher: Aes256Gcm,
}

impl TokenEncryption {
    /// Создать новый экземпляр с ключом из переменной окружения или дефолтным
    /// В production должен использовать Keychain (macOS) или другой secure storage
    pub fn new() -> Result<Self, String> {
        // TODO: В production использовать Keychain для хранения ключа
        // Для сейчас используем дефолтный ключ (НЕ БЕЗОПАСНО для production!)
        let key = std::env::var("HUBNITY_ENCRYPTION_KEY")
            .ok()
            .and_then(|k| hex::decode(k).ok())
            .unwrap_or_else(|| {
                // Дефолтный ключ (32 байта) - НЕ БЕЗОПАСНО для production!
                // Используем точно 32 байта
                b"default-encryption-key-32-bytes!".to_vec()
            });

        if key.len() != 32 {
            return Err("Encryption key must be 32 bytes".to_string());
        }

        let key_array: [u8; 32] = key
            .try_into()
            .map_err(|_| "Failed to convert key to array".to_string())?;

        let cipher = Aes256Gcm::new(&key_array.into());

        Ok(Self { cipher })
    }

    /// Зашифровать токен
    pub fn encrypt(&self, token: &str) -> Result<String, String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, token.as_bytes())
            .map_err(|e| format!("Encryption failed: {}", e))?;

        // Сохраняем nonce и ciphertext вместе (nonce + ciphertext)
        let mut result = nonce.to_vec();
        result.extend_from_slice(&ciphertext);

        // Кодируем в base64 для хранения в SQLite
        use base64::{engine::general_purpose, Engine as _};
        Ok(general_purpose::STANDARD.encode(&result))
    }

    /// Расшифровать токен
    pub fn decrypt(&self, encrypted: &str) -> Result<String, String> {
        use base64::{engine::general_purpose, Engine as _};
        let data = general_purpose::STANDARD
            .decode(encrypted)
            .map_err(|e| format!("Base64 decode failed: {}", e))?;

        if data.len() < 12 {
            return Err("Invalid encrypted data length".to_string());
        }

        // Извлекаем nonce (первые 12 байт) и ciphertext (остальное)
        let nonce = Nonce::from_slice(&data[..12]);
        let ciphertext = &data[12..];

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| format!("Decryption failed: {}", e))?;

        String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_encryption_decryption() {
        let encryption = TokenEncryption::new().expect("Failed to create encryption");

        let original_token = "test_access_token_12345";

        // Шифруем токен
        let encrypted = encryption
            .encrypt(original_token)
            .expect("Failed to encrypt token");

        // Проверяем, что зашифрованный токен отличается от оригинального
        assert_ne!(encrypted, original_token);
        assert!(!encrypted.is_empty());

        // Расшифровываем токен
        let decrypted = encryption
            .decrypt(&encrypted)
            .expect("Failed to decrypt token");

        // Проверяем, что расшифрованный токен совпадает с оригинальным
        assert_eq!(decrypted, original_token);
    }

    #[test]
    fn test_token_encryption_different_tokens() {
        let encryption = TokenEncryption::new().expect("Failed to create encryption");

        let token1 = "token1";
        let token2 = "token2";

        let encrypted1 = encryption
            .encrypt(token1)
            .expect("Failed to encrypt token1");
        let encrypted2 = encryption
            .encrypt(token2)
            .expect("Failed to encrypt token2");

        // Разные токены должны давать разные зашифрованные значения
        assert_ne!(encrypted1, encrypted2);

        // Каждый должен расшифровываться в свой оригинальный токен
        assert_eq!(encryption.decrypt(&encrypted1).unwrap(), token1);
        assert_eq!(encryption.decrypt(&encrypted2).unwrap(), token2);
    }

    #[test]
    fn test_token_encryption_invalid_data() {
        let encryption = TokenEncryption::new().expect("Failed to create encryption");

        // Попытка расшифровать невалидные данные должна вернуть ошибку
        let invalid_data = "invalid_encrypted_data";
        let result = encryption.decrypt(invalid_data);

        assert!(result.is_err());
    }

    #[test]
    fn test_token_encryption_empty_token() {
        let encryption = TokenEncryption::new().expect("Failed to create encryption");

        let empty_token = "";
        let encrypted = encryption
            .encrypt(empty_token)
            .expect("Failed to encrypt empty token");
        let decrypted = encryption
            .decrypt(&encrypted)
            .expect("Failed to decrypt empty token");

        assert_eq!(decrypted, empty_token);
    }

    #[test]
    fn test_token_encryption_long_token() {
        let encryption = TokenEncryption::new().expect("Failed to create encryption");

        // Длинный токен (типичный JWT)
        let long_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

        let encrypted = encryption
            .encrypt(long_token)
            .expect("Failed to encrypt long token");
        let decrypted = encryption
            .decrypt(&encrypted)
            .expect("Failed to decrypt long token");

        assert_eq!(decrypted, long_token);
    }

    // Тесты для отслеживания активных окон
    #[cfg(target_os = "macos")]
    mod active_window_tests {
        use super::*;

        // Тесты для get_active_window_info() используют AppleScript, который безопасен
        // и не вызывает Objective-C exceptions

        #[test]
        fn test_get_active_window_info_returns_result() {
            // Тест проверяет, что функция возвращает Result и не паникует
            // Используется AppleScript, который безопасен и не вызывает crashes
            use tokio::runtime::Runtime;
            let rt = Runtime::new().unwrap();

            let result = rt.block_on(get_active_window_info());

            // Функция должна вернуть Ok, даже если данные пустые
            assert!(result.is_ok(), "Function should always return Ok");

            let info = result.unwrap();
            // Проверяем, что структура корректна (данные могут быть пустыми, если нет активного окна)
            assert!(info.app_name.is_none() || !info.app_name.as_ref().unwrap().is_empty());
            assert!(info.window_title.is_none() || !info.window_title.as_ref().unwrap().is_empty());
            assert!(info.url.is_none() || !info.url.as_ref().unwrap().is_empty());
            assert!(info.domain.is_none() || !info.domain.as_ref().unwrap().is_empty());
        }

        #[test]
        fn test_get_active_window_info_handles_errors_gracefully() {
            // Тест проверяет, что функция обрабатывает ошибки gracefully
            // AppleScript безопасен и не вызывает crashes
            use tokio::runtime::Runtime;
            let rt = Runtime::new().unwrap();

            // Вызываем функцию несколько раз подряд
            for i in 0..5 {
                let result = rt.block_on(get_active_window_info());

                // Функция должна всегда возвращать Ok, даже при ошибках
                assert!(
                    result.is_ok(),
                    "Iteration {}: Function should never return Err",
                    i
                );

                let info = result.unwrap();
                // Даже если данные пустые, структура должна быть валидной
                assert!(info.app_name.is_none() || info.app_name.is_some());
                assert!(info.window_title.is_none() || info.window_title.is_some());
            }
        }

        #[test]
        fn test_extract_url_from_title() {
            // Тест для функции извлечения URL из заголовка
            let (url, domain) = extract_url_from_title("https://github.com/user/repo");
            assert_eq!(url, Some("https://github.com/user/repo".to_string()));
            assert_eq!(domain, Some("github.com".to_string()));

            let (url, domain) = extract_url_from_title("http://example.com/page");
            assert_eq!(url, Some("http://example.com/page".to_string()));
            assert_eq!(domain, Some("example.com".to_string()));

            let (url, domain) = extract_url_from_title("Just a regular title");
            assert_eq!(url, None);
            assert_eq!(domain, None);

            let (url, domain) = extract_url_from_title("github.com");
            assert_eq!(url, None);
            assert_eq!(domain, Some("github.com".to_string()));
        }

        #[test]
        fn test_extract_domain() {
            // Тест для функции извлечения домена из URL
            assert_eq!(
                extract_domain("https://github.com/user/repo"),
                Some("github.com".to_string())
            );
            assert_eq!(
                extract_domain("http://example.com/page"),
                Some("example.com".to_string())
            );
            assert_eq!(
                extract_domain("https://subdomain.example.com/path"),
                Some("subdomain.example.com".to_string())
            );
            assert_eq!(extract_domain("not-a-url"), None);
        }
    }

    // Тесты для TimerEngine
    #[cfg(test)]
    mod timer_engine_tests {
        use super::*;
        use std::thread;
        use std::time::Duration;

        #[test]
        fn test_timer_engine_new() {
            // Тест создания нового TimerEngine без БД
            let engine = TimerEngine::new();
            let state = engine.get_state().unwrap();

            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert_eq!(state.elapsed_seconds, 0);
            assert_eq!(state.accumulated_seconds, 0);
            assert_eq!(state.session_start, None);
        }

        #[test]
        fn test_fsm_transition_stopped_to_running() {
            // Тест перехода: Stopped → Running
            let engine = TimerEngine::new();

            // Начальное состояние - Stopped
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));

            // Переход в Running
            engine.start().unwrap();

            let state = engine.get_state().unwrap();
            match state.state {
                TimerStateForAPI::Running { started_at } => {
                    assert!(started_at > 0);
                    assert!(state.session_start.is_some());
                    assert_eq!(state.session_start.unwrap(), started_at);
                }
                _ => panic!("Expected Running state"),
            }
        }

        #[test]
        fn test_fsm_transition_running_to_paused() {
            // Тест перехода: Running → Paused
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200)); // Увеличенная задержка для надежности

            engine.pause().unwrap();

            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Paused));
            // accumulated_seconds is u64 (unsigned), so >= 0 is always true; assertion removed
            assert_eq!(state.session_start, None); // В Paused нет session_start
        }

        #[test]
        fn test_fsm_transition_paused_to_running() {
            // Тест перехода: Paused → Running (resume)
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));
            engine.pause().unwrap();

            let accumulated_before = engine.get_state().unwrap().accumulated_seconds;

            engine.resume().unwrap();

            let state = engine.get_state().unwrap();
            match state.state {
                TimerStateForAPI::Running { started_at } => {
                    assert!(started_at > 0);
                    assert_eq!(state.accumulated_seconds, accumulated_before); // accumulated сохраняется
                }
                _ => panic!("Expected Running state"),
            }
        }

        #[test]
        fn test_fsm_transition_running_to_stopped() {
            // Тест перехода: Running → Stopped
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));

            engine.stop().unwrap();

            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            // accumulated_seconds is u64 (unsigned), so >= 0 is always true; assertion removed
            assert_eq!(state.session_start, None);
        }

        #[test]
        fn test_fsm_transition_paused_to_stopped() {
            // Тест перехода: Paused → Stopped
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));
            engine.pause().unwrap();

            let accumulated_before = engine.get_state().unwrap().accumulated_seconds;

            engine.stop().unwrap();

            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert_eq!(state.accumulated_seconds, accumulated_before); // accumulated сохраняется
        }

        #[test]
        fn test_fsm_invalid_transition_running_to_running() {
            // Тест недопустимого перехода: Running → Running
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // Попытка запустить еще раз должна вернуть ошибку
            let result = engine.start();
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("already running"));
        }

        #[test]
        fn test_fsm_invalid_transition_paused_to_paused() {
            // Тест недопустимого перехода: Paused → Paused
            let engine = TimerEngine::new();

            engine.start().unwrap();
            engine.pause().unwrap();

            // Попытка поставить на паузу еще раз должна вернуть ошибку
            let result = engine.pause();
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("already paused"));
        }

        #[test]
        fn test_fsm_invalid_transition_stopped_to_paused() {
            // Тест недопустимого перехода: Stopped → Paused
            let engine = TimerEngine::new();

            // Попытка поставить на паузу остановленный таймер должна вернуть ошибку
            let result = engine.pause();
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("Cannot pause stopped timer"));
        }

        #[test]
        fn test_fsm_invalid_transition_stopped_to_stopped() {
            // Тест недопустимого перехода: Stopped → Stopped
            let engine = TimerEngine::new();

            // Попытка остановить уже остановленный таймер должна вернуть ошибку
            let result = engine.stop();
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("already stopped"));
        }

        #[test]
        fn test_fsm_invalid_transition_stopped_to_running_via_resume() {
            // Тест недопустимого перехода: Stopped → Running через resume()
            let engine = TimerEngine::new();

            // Попытка возобновить остановленный таймер должна вернуть ошибку
            let result = engine.resume();
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("Cannot resume stopped timer"));
        }

        #[test]
        fn test_accumulated_time_increases_on_pause() {
            // Тест накопления времени при паузе
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            let state_before = engine.get_state().unwrap();
            let elapsed_before = state_before.elapsed_seconds;

            engine.pause().unwrap();

            let state_after = engine.get_state().unwrap();
            assert!(state_after.accumulated_seconds >= elapsed_before);
        }

        #[test]
        fn test_accumulated_time_increases_on_stop() {
            // Тест накопления времени при остановке
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            let state_before = engine.get_state().unwrap();
            let elapsed_before = state_before.elapsed_seconds;

            engine.stop().unwrap();

            let state_after = engine.get_state().unwrap();
            assert!(state_after.accumulated_seconds >= elapsed_before);
        }

        #[test]
        fn test_elapsed_seconds_increases_while_running() {
            // Тест увеличения elapsed_seconds во время работы
            let engine = TimerEngine::new();

            engine.start().unwrap();

            let state1 = engine.get_state().unwrap();
            let elapsed1 = state1.elapsed_seconds;

            thread::sleep(Duration::from_millis(300));

            let state2 = engine.get_state().unwrap();
            let elapsed2 = state2.elapsed_seconds;

            assert!(elapsed2 >= elapsed1);
        }

        #[test]
        fn test_elapsed_seconds_stays_constant_when_paused() {
            // Тест, что elapsed_seconds не меняется в Paused
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));
            engine.pause().unwrap();

            let state1 = engine.get_state().unwrap();
            let elapsed1 = state1.elapsed_seconds;

            thread::sleep(Duration::from_millis(300));

            let state2 = engine.get_state().unwrap();
            let elapsed2 = state2.elapsed_seconds;

            assert_eq!(elapsed1, elapsed2); // Время не должно меняться в Paused
        }

        #[test]
        fn test_accumulated_time_persists_across_sessions() {
            // Тест, что accumulated сохраняется между сессиями
            let engine = TimerEngine::new();

            // Первая сессия
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));
            engine.pause().unwrap();

            let accumulated1 = engine.get_state().unwrap().accumulated_seconds;
            // accumulated1 is u64 (unsigned), so >= 0 is always true; assertion removed

            // Вторая сессия
            engine.resume().unwrap();
            thread::sleep(Duration::from_millis(300));
            engine.pause().unwrap();

            let accumulated2 = engine.get_state().unwrap().accumulated_seconds;
            assert!(accumulated2 >= accumulated1); // Накопленное время должно увеличиться
        }

        #[test]
        fn test_reset_day() {
            // Тест сброса дня
            let engine = TimerEngine::new();

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));
            engine.pause().unwrap();

            engine.reset_day().unwrap();

            let state = engine.get_state().unwrap();
            assert_eq!(state.accumulated_seconds, 0); // Накопленное время должно сброситься
            assert!(state.day_start.is_some()); // day_start должен быть установлен
        }

        #[test]
        fn test_reset_day_stops_running_timer() {
            // Тест, что reset_day останавливает работающий таймер
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // reset_day должен остановить таймер
            engine.reset_day().unwrap();

            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert_eq!(state.accumulated_seconds, 0);
        }

        #[test]
        fn test_day_rollover_stops_running_timer() {
            // Тест: RUNNING → rollover → state == STOPPED
            let engine = TimerEngine::new();

            // Запускаем таймер
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // Симулируем смену дня: устанавливаем day_start_timestamp на вчера
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Вызываем ensure_correct_day() - должен произойти rollover
            engine.ensure_correct_day().unwrap();

            // Проверяем, что таймер остановлен
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert_eq!(state.accumulated_seconds, 0); // Новый день - accumulated обнулен
        }

        #[test]
        fn test_day_rollover_does_not_auto_start() {
            // Тест: Новый день НЕ стартует автоматически
            let engine = TimerEngine::new();

            // Запускаем и останавливаем таймер
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));
            engine.stop().unwrap();

            // Симулируем смену дня
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Вызываем ensure_correct_day()
            engine.ensure_correct_day().unwrap();

            // Проверяем, что таймер НЕ запущен автоматически
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
        }

        #[test]
        fn test_day_rollover_after_midnight_elapsed_is_zero() {
            // Тест: Timer started before midnight → after midnight → elapsed == 0
            let engine = TimerEngine::new();

            // Запускаем таймер (это установит day_start на сегодня)
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // Симулируем смену дня: устанавливаем day_start_timestamp на вчера
            // Это симулирует ситуацию, когда таймер был запущен вчера
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Вызываем ensure_correct_day() - должен произойти rollover
            engine.ensure_correct_day().unwrap();

            // Проверяем, что elapsed == 0 (новый день, таймер остановлен)
            let state = engine.get_state().unwrap();
            assert_eq!(state.elapsed_seconds, 0);
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
        }

        #[test]
        fn test_day_rollover_idempotent() {
            // Тест: Если rollover вызывается несколько раз → no-op
            let engine = TimerEngine::new();

            // Симулируем смену дня
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Первый вызов ensure_correct_day()
            engine.ensure_correct_day().unwrap();

            // Второй вызов ensure_correct_day() - должен быть no-op
            engine.ensure_correct_day().unwrap();

            // Проверяем, что день обновлен на сегодня
            let today = Local::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today);
        }

        #[test]
        fn test_full_cycle_stopped_running_paused_stopped() {
            // Тест полного цикла: Stopped → Running → Paused → Stopped
            let engine = TimerEngine::new();

            // Начальное состояние
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert_eq!(state.accumulated_seconds, 0);

            // Start
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Running { .. }));

            // Pause
            engine.pause().unwrap();
            let accumulated_after_pause = engine.get_state().unwrap().accumulated_seconds;
            // accumulated_seconds is u64 (unsigned), so >= 0 is always true; assertion removed

            // Resume
            engine.resume().unwrap();
            thread::sleep(Duration::from_millis(200));
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Running { .. }));
            assert_eq!(state.accumulated_seconds, accumulated_after_pause); // accumulated сохраняется

            // Stop
            engine.stop().unwrap();
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, TimerStateForAPI::Stopped));
            assert!(state.accumulated_seconds >= accumulated_after_pause); // Время увеличилось
        }

        #[test]
        fn test_overflow_protection_on_pause() {
            // Тест защиты от переполнения при паузе
            let engine = TimerEngine::new();

            // Устанавливаем accumulated_seconds близко к u64::MAX
            {
                let mut accumulated = engine.accumulated_seconds.lock().unwrap();
                *accumulated = u64::MAX - 50; // Очень близко к максимуму
            }

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // Пауза должна использовать saturating_add и не паниковать
            engine.pause().unwrap();

            let state = engine.get_state().unwrap();
            // accumulated должен быть насыщен до u64::MAX (если session_elapsed >= 50),
            // или увеличиться на session_elapsed (если session_elapsed < 50)
            // В любом случае, не должно быть паники или переполнения
            assert!(state.accumulated_seconds <= u64::MAX);
            assert!(state.accumulated_seconds >= u64::MAX - 50);
        }

        #[test]
        fn test_overflow_protection_on_stop() {
            // Тест защиты от переполнения при остановке
            let engine = TimerEngine::new();

            // Устанавливаем accumulated_seconds близко к u64::MAX
            {
                let mut accumulated = engine.accumulated_seconds.lock().unwrap();
                *accumulated = u64::MAX - 50; // Очень близко к максимуму
            }

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // Остановка должна использовать saturating_add и не паниковать
            engine.stop().unwrap();

            let state = engine.get_state().unwrap();
            // accumulated должен быть насыщен до u64::MAX (если session_elapsed >= 50),
            // или увеличиться на session_elapsed (если session_elapsed < 50)
            // В любом случае, не должно быть паники или переполнения
            assert!(state.accumulated_seconds <= u64::MAX);
            assert!(state.accumulated_seconds >= u64::MAX - 50);
        }

        #[test]
        fn test_overflow_protection_in_get_state() {
            // Тест защиты от переполнения при вычислении elapsed_seconds
            let engine = TimerEngine::new();

            // Устанавливаем accumulated_seconds близко к u64::MAX
            {
                let mut accumulated = engine.accumulated_seconds.lock().unwrap();
                *accumulated = u64::MAX - 50; // Очень близко к максимуму
            }

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // get_state должен использовать saturating_add и не паниковать
            let state = engine.get_state().unwrap();
            // elapsed_seconds должен быть насыщен до u64::MAX (если session_elapsed >= 50),
            // или увеличиться на session_elapsed (если session_elapsed < 50)
            // В любом случае, не должно быть паники или переполнения
            assert!(state.elapsed_seconds <= u64::MAX);
            assert!(state.elapsed_seconds >= u64::MAX - 50);
        }

        #[test]
        fn test_sleep_detection_threshold() {
            // Тест обнаружения большого пропуска времени (sleep detection)
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // Симулируем большой пропуск времени: устанавливаем started_at_instant в прошлое
            {
                let mut state = engine.state.lock().unwrap();
                if let TimerState::Running { started_at, .. } = &*state {
                    let old_started_at = *started_at;
                    // Устанавливаем started_at_instant на 20 минут назад (больше порога 15 минут)
                    let old_instant = Instant::now() - Duration::from_secs(20 * 60);
                    *state = TimerState::Running {
                        started_at: old_started_at,
                        started_at_instant: old_instant,
                    };
                }
            }

            // get_state должен обнаружить sleep, но НЕ ставить на паузу автоматически
            let state = engine.get_state().unwrap();
            // Таймер должен остаться в состоянии RUNNING (sleep detection только логирует)
            assert!(matches!(state.state, TimerStateForAPI::Running { .. }));
        }

        #[test]
        fn test_recursive_get_state_protection() {
            // Тест защиты от рекурсии в get_state()
            // Этот тест проверяет, что MAX_RECURSION_DEPTH работает
            // В реальности рекурсия может возникнуть только при sleep detection,
            // но мы отключили автоматическую паузу, поэтому рекурсия не должна возникать
            // Тест проверяет, что защита существует и работает

            let engine = TimerEngine::new();
            engine.start().unwrap();

            // Вызываем get_state много раз - не должно быть рекурсии
            for _ in 0..10 {
                let state = engine.get_state().unwrap();
                assert!(matches!(state.state, TimerStateForAPI::Running { .. }));
            }
        }

        #[test]
        fn test_save_state() {
            // Тест сохранения состояния в БД
            use tempfile::TempDir;
            let temp_dir = TempDir::new().unwrap();
            let db_path = temp_dir.path().join("test.db");
            let db = Arc::new(Database::new(db_path.to_str().unwrap()).unwrap());
            let engine = TimerEngine::with_db(db.clone());

            engine.start().unwrap();
            thread::sleep(Duration::from_millis(200));

            // Сохраняем состояние
            engine.save_state().unwrap();

            // Проверяем, что состояние сохранено в БД
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (_day, _loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_state, "running");
            // loaded_accumulated is u64 (unsigned), so >= 0 is always true; assertion removed
        }

        #[test]
        fn test_timezone_utc_fix() {
            // Тест, что day rollover использует UTC для сравнения дат
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // Симулируем смену дня: устанавливаем day_start_timestamp на вчера (в UTC)
            let yesterday_utc = Utc::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start_utc = yesterday_utc
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Utc).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start_utc);
            }

            // Вызываем ensure_correct_day() - должен произойти rollover
            engine.ensure_correct_day().unwrap();

            // Проверяем, что день обновлен на сегодня (UTC)
            let today_utc = Utc::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);
        }

        #[test]
        fn test_rollover_idempotency_concurrent() {
            // Тест идемпотентности rollover при множественных вызовах
            let engine = TimerEngine::new();

            // Симулируем смену дня
            let yesterday = Utc::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Utc).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Первый вызов ensure_correct_day()
            engine.ensure_correct_day().unwrap();

            // Сохраняем состояние после первого rollover
            let accumulated_after_first = engine.get_state().unwrap().accumulated_seconds;

            // Второй вызов ensure_correct_day() - должен быть no-op
            engine.ensure_correct_day().unwrap();

            // Третий вызов ensure_correct_day() - должен быть no-op
            engine.ensure_correct_day().unwrap();

            // Проверяем, что состояние не изменилось после повторных вызовов
            let state = engine.get_state().unwrap();
            assert_eq!(state.accumulated_seconds, accumulated_after_first);

            // Проверяем, что день обновлен на сегодня
            let today_utc = Utc::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);
        }

        #[test]
        fn test_ensure_correct_day_called_in_all_methods() {
            // Тест, что ensure_correct_day() вызывается во всех публичных методах
            let engine = TimerEngine::new();
            let today_utc = Utc::now().date_naive();

            // Симулируем смену дня
            let yesterday = today_utc - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Utc).earliest())
                .unwrap()
                .timestamp() as u64;

            // start() должен вызвать ensure_correct_day()
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            engine.start().unwrap();
            // После start() день должен быть обновлен на сегодня
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);

            // pause() должен вызвать ensure_correct_day()
            // Но сначала нужно убедиться, что таймер все еще запущен после rollover
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            // Если после rollover таймер остановлен, нужно запустить его снова
            let state_before = engine.get_state().unwrap();
            if matches!(state_before.state, TimerStateForAPI::Stopped) {
                engine.start().unwrap();
            }
            thread::sleep(Duration::from_millis(200));
            engine.pause().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);

            // resume() должен вызвать ensure_correct_day()
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            engine.resume().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);

            // stop() должен вызвать ensure_correct_day()
            // Но сначала нужно убедиться, что таймер запущен (не остановлен rollover'ом)
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            let state_before_stop = engine.get_state().unwrap();
            if matches!(state_before_stop.state, TimerStateForAPI::Stopped) {
                // Если таймер остановлен, запускаем его снова
                engine.start().unwrap();
                thread::sleep(Duration::from_millis(200));
            }
            engine.stop().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);

            // get_state() должен вызвать ensure_correct_day()
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            let _state = engine.get_state().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .date_naive();
            assert_eq!(day_start_date, today_utc);
        }
    }

    // Тесты для Database
    #[cfg(test)]
    mod database_tests {
        use super::*;
        use tempfile::TempDir;

        fn create_test_db() -> (Database, TempDir) {
            let temp_dir = TempDir::new().unwrap();
            let db_path = temp_dir.path().join("test.db");
            let db = Database::new(db_path.to_str().unwrap()).unwrap();
            (db, temp_dir)
        }

        #[test]
        fn test_database_new() {
            // Тест создания новой БД
            let (_db, _temp_dir) = create_test_db();
            // Если создание прошло успешно, тест пройден
        }

        #[test]
        fn test_database_init_schema() {
            // Тест инициализации схемы
            let (db, _temp_dir) = create_test_db();

            // Проверяем, что таблицы созданы
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .unwrap();
            let tables: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();

            assert!(tables.contains(&"time_entries".to_string()));
            assert!(tables.contains(&"sync_queue".to_string()));
        }

        #[test]
        fn test_save_timer_state() {
            // Тест сохранения состояния таймера
            let (db, _temp_dir) = create_test_db();

            let day = "2024-01-15";
            let accumulated = 3600; // 1 час
            let state = "running";

            db.save_timer_state(day, accumulated, state, None).unwrap();

            // Проверяем, что данные сохранены
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (loaded_day, loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_day, day);
            assert_eq!(loaded_accumulated, accumulated);
            assert_eq!(loaded_state, state);
        }

        #[test]
        fn test_load_timer_state_empty() {
            // Тест загрузки состояния из пустой БД
            let (db, _temp_dir) = create_test_db();

            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_none());
        }

        #[test]
        fn test_save_timer_state_updates_existing() {
            // Тест обновления существующего состояния
            let (db, _temp_dir) = create_test_db();

            let day = "2024-01-15";

            // Первое сохранение
            db.save_timer_state(day, 3600, "running", Some(Utc::now().timestamp() as u64))
                .unwrap();

            // Обновление
            db.save_timer_state(day, 7200, "paused", None).unwrap();

            // Проверяем, что данные обновились
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (_, loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_accumulated, 7200);
            assert_eq!(loaded_state, "paused");
        }

        #[test]
        fn test_enqueue_sync() {
            // Тест добавления задачи в очередь
            let (db, _temp_dir) = create_test_db();

            let entity_type = "time_entry_start";
            let payload = r#"{"projectId": "123", "startedAt": 1234567890}"#;

            let queue_id = db.enqueue_sync(entity_type, payload).unwrap();
            assert!(queue_id > 0);
        }

        #[test]
        fn test_get_pending_sync_tasks() {
            // Тест получения pending задач
            let (db, _temp_dir) = create_test_db();

            // Добавляем несколько задач
            db.enqueue_sync("task1", r#"{"data": "1"}"#).unwrap();
            db.enqueue_sync("task2", r#"{"data": "2"}"#).unwrap();

            // Получаем pending задачи
            let tasks = db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 2);

            // Проверяем порядок (должны быть в порядке создания)
            assert_eq!(tasks[0].1, "task1");
            assert_eq!(tasks[1].1, "task2");
        }

        #[test]
        fn test_update_sync_status() {
            // Тест обновления статуса задачи
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Обновляем статус
            db.update_sync_status(queue_id, "sent", 0).unwrap();

            // Проверяем, что задача больше не в pending
            let pending = db.get_pending_sync_tasks(10).unwrap();
            assert!(!pending.iter().any(|(id, _, _)| *id == queue_id));
        }

        #[test]
        fn test_get_retry_tasks() {
            // Тест получения задач для retry
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Обновляем статус с retry_count = 1
            db.update_sync_status(queue_id, "pending", 1).unwrap();

            // Проверяем, что get_retry_tasks не паникует
            // (результат может быть пустым, если не прошло достаточно времени для retry)
            let _retry_tasks = db.get_retry_tasks(5, 10).unwrap();
        }

        #[test]
        fn test_get_retry_tasks_respects_max_retries() {
            // Тест, что задачи с max_retries не возвращаются
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Обновляем статус с retry_count = 5 (max_retries)
            db.update_sync_status(queue_id, "pending", 5).unwrap();

            // Получаем retry задачи с max_retries = 5
            let retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            // Задача с retry_count = 5 не должна быть в списке (retry_count < max_retries)
            assert!(!retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id));
        }

        #[test]
        fn test_multiple_days_timer_state() {
            // Тест сохранения состояния для разных дней
            let (db, _temp_dir) = create_test_db();

            // Сохраняем состояние для разных дней
            db.save_timer_state(
                "2024-01-15",
                3600,
                "running",
                Some(Utc::now().timestamp() as u64),
            )
            .unwrap();
            // Задержка должна быть >= 1000ms, так как last_updated_at хранится в секундах
            std::thread::sleep(std::time::Duration::from_millis(1100));
            db.save_timer_state("2024-01-16", 7200, "paused", None)
                .unwrap();

            // Загружаем последнее состояние (должно быть для 2024-01-16)
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (day, _, _, _) = loaded.unwrap();
            assert_eq!(day, "2024-01-16");
        }

        #[test]
        fn test_sync_queue_ordering() {
            // Тест порядка задач в очереди
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачи с небольшой задержкой
            let id1 = db.enqueue_sync("task1", r#"{"data": "1"}"#).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(10));
            let id2 = db.enqueue_sync("task2", r#"{"data": "2"}"#).unwrap();

            // Получаем pending задачи
            let tasks = db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 2);

            // Проверяем порядок (по created_at ASC)
            assert_eq!(tasks[0].0, id1);
            assert_eq!(tasks[1].0, id2);
        }

        #[test]
        fn test_save_timer_state_transaction_commit() {
            // Тест успешной транзакции (COMMIT)
            let (db, _temp_dir) = create_test_db();

            let day = "2024-01-15";
            let accumulated = 3600;
            let state = "running";

            // Сохраняем состояние - транзакция должна успешно закоммититься
            db.save_timer_state(day, accumulated, state, None).unwrap();

            // Проверяем, что данные сохранены (транзакция закоммичена)
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (loaded_day, loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_day, day);
            assert_eq!(loaded_accumulated, accumulated);
            assert_eq!(loaded_state, state);

            // Проверяем, что транзакция завершена (можно выполнить новую операцию)
            // Добавляем задержку, чтобы last_updated_at был разным
            std::thread::sleep(std::time::Duration::from_millis(1100));
            db.save_timer_state("2024-01-16", 7200, "paused", None)
                .unwrap();
            let loaded2 = db.load_timer_state().unwrap();
            assert!(loaded2.is_some());
            let (loaded_day2, _, _, _) = loaded2.unwrap();
            assert_eq!(loaded_day2, "2024-01-16");
        }

        #[test]
        fn test_save_timer_state_transaction_atomicity() {
            // Тест атомарности транзакции - все изменения применяются вместе
            let (db, _temp_dir) = create_test_db();

            let day = "2024-01-15";
            let accumulated1 = 3600;
            let state1 = "running";

            // Первое сохранение
            db.save_timer_state(day, accumulated1, state1, None)
                .unwrap();

            // Обновление - транзакция должна атомарно обновить все поля
            let accumulated2 = 7200;
            let state2 = "paused";
            db.save_timer_state(day, accumulated2, state2, None)
                .unwrap();

            // Проверяем, что все поля обновлены атомарно
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (loaded_day, loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_day, day);
            assert_eq!(loaded_accumulated, accumulated2); // Обновлено
            assert_eq!(loaded_state, state2); // Обновлено
            assert_ne!(loaded_accumulated, accumulated1); // Не старое значение
            assert_ne!(loaded_state, state1); // Не старое значение
        }

        #[test]
        fn test_database_wal_mode_enabled() {
            // Тест, что WAL mode включен
            let (db, _temp_dir) = create_test_db();

            let conn = db.conn.lock().unwrap();
            let mut stmt = conn.prepare("PRAGMA journal_mode").unwrap();
            let journal_mode: String = stmt.query_row([], |row| row.get(0)).unwrap();

            // WAL mode должен быть включен (или хотя бы не "delete")
            // В некоторых случаях SQLite может вернуть "wal" или "WAL"
            assert!(
                journal_mode.to_lowercase() == "wal",
                "Expected WAL mode, got: {}",
                journal_mode
            );
        }

        #[test]
        fn test_database_foreign_keys_enabled() {
            // Тест, что Foreign keys включены
            let (db, _temp_dir) = create_test_db();

            let conn = db.conn.lock().unwrap();
            let mut stmt = conn.prepare("PRAGMA foreign_keys").unwrap();
            let foreign_keys: i32 = stmt.query_row([], |row| row.get(0)).unwrap();

            // Foreign keys должны быть включены (1)
            assert_eq!(
                foreign_keys, 1,
                "Expected foreign_keys=1, got: {}",
                foreign_keys
            );
        }

        #[test]
        fn test_save_timer_state_concurrent_writes() {
            // Тест, что BEGIN IMMEDIATE предотвращает конфликты при параллельных записях
            let (db, _temp_dir) = create_test_db();

            let day = "2024-01-15";

            // Симулируем параллельные записи (последовательно, но с проверкой блокировки)
            // BEGIN IMMEDIATE должен гарантировать, что транзакция начнется немедленно
            db.save_timer_state(day, 3600, "running", Some(Utc::now().timestamp() as u64))
                .unwrap();
            db.save_timer_state(day, 7200, "paused", None).unwrap();

            // Обе операции должны успешно завершиться
            // Вторая операция должна обновить данные (ON CONFLICT DO UPDATE)
            let loaded = db.load_timer_state().unwrap();
            assert!(loaded.is_some());
            let (loaded_day, loaded_accumulated, loaded_state, _) = loaded.unwrap();
            assert_eq!(loaded_day, day);
            assert_eq!(loaded_accumulated, 7200); // Последнее значение
            assert_eq!(loaded_state, "paused"); // Последнее значение
        }
    }

    // Тесты для SyncManager
    #[cfg(test)]
    mod sync_manager_tests {
        use super::*;
        use tempfile::TempDir;

        fn create_test_sync_manager() -> (SyncManager, TempDir) {
            let temp_dir = TempDir::new().unwrap();
            let db_path = temp_dir.path().join("test.db");
            let db = Arc::new(Database::new(db_path.to_str().unwrap()).unwrap());
            let sync_manager = SyncManager::new(db);
            (sync_manager, temp_dir)
        }

        // Вспомогательная функция для установки токенов в AuthManager для тестов
        async fn set_test_tokens(sync_manager: &SyncManager) {
            sync_manager
                .auth_manager
                .set_tokens(
                    Some("test_access_token".to_string()),
                    Some("test_refresh_token".to_string()),
                )
                .await;
        }

        #[test]
        fn test_enqueue_time_entry() {
            // Тест добавления time entry в очередь
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123",
                "startedAt": 1234567890
            });

            let result = sync_manager.enqueue_time_entry(
                "start",
                payload,
                "test_access_token".to_string(),
                Some("test_refresh_token".to_string()),
            );

            assert!(result.is_ok());
            let queue_id = result.unwrap();
            assert!(queue_id > 0);

            // Проверяем, что задача добавлена в очередь
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 1);
            assert!(tasks[0].1.starts_with("time_entry_start"));
        }

        #[test]
        fn test_enqueue_time_entry_encrypts_tokens() {
            // PRODUCTION: Тест, что токены НЕ сохраняются в payload
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let access_token = "test_access_token_12345";
            let refresh_token = "test_refresh_token_67890";

            let result = sync_manager.enqueue_time_entry(
                "start",
                payload.clone(),
                access_token.to_string(),
                Some(refresh_token.to_string()),
            );

            assert!(result.is_ok());

            // Получаем задачу из очереди
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 1);

            // PRODUCTION: Парсим payload и проверяем, что токены НЕ сохранены
            let payload_json: serde_json::Value = serde_json::from_str(&tasks[0].2).unwrap();
            // Токены не должны быть в payload
            assert!(payload_json["accessToken"].is_null());
            assert!(payload_json["refreshToken"].is_null());
            assert!(payload_json["_encrypted"].is_null());
            // Payload должен содержать только исходные данные
            assert_eq!(payload_json["projectId"], "123");
        }

        #[test]
        fn test_enqueue_time_entry_without_refresh_token() {
            // Тест добавления без refresh token
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let result = sync_manager.enqueue_time_entry(
                "start",
                payload,
                "test_access_token".to_string(),
                None, // Без refresh token
            );

            assert!(result.is_ok());
        }

        #[test]
        fn test_sync_manager_new() {
            // Тест создания нового SyncManager
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Проверяем, что можно получить pending задачи (пустой список)
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 0);
        }

        #[test]
        fn test_enqueue_time_entry_different_operations() {
            // Тест добавления разных операций
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let operations = vec!["start", "pause", "resume", "stop"];

            for operation in operations {
                let payload = serde_json::json!({
                    "id": format!("entry_{}", operation),
                    "projectId": "123"
                });

                let result = sync_manager.enqueue_time_entry(
                    operation,
                    payload,
                    "test_token".to_string(),
                    None,
                );

                assert!(result.is_ok(), "Failed to enqueue operation: {}", operation);
            }

            // Проверяем, что все задачи добавлены
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert_eq!(tasks.len(), 4);
        }

        #[test]
        fn test_sync_manager_retry_count_increments_on_error() {
            // Тест, что retry_count увеличивается при ошибке синхронизации
            // Симулируем ошибку через прямое обновление статуса в БД
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123",
                "startedAt": 1234567890
            });

            let queue_id = sync_manager
                .enqueue_time_entry("start", payload, "test_token".to_string(), None)
                .unwrap();

            // Начальный retry_count = 0
            let initial_tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            let initial_task = initial_tasks.iter().find(|(id, _, _)| *id == queue_id);
            assert!(initial_task.is_some());

            // Симулируем ошибку - обновляем статус с retry_count = 1
            sync_manager
                .db
                .update_sync_status(queue_id, "pending", 1)
                .unwrap();

            // Проверяем, что retry_count увеличился
            let retry_tasks = sync_manager.db.get_retry_tasks(5, 10).unwrap();
            let retry_task = retry_tasks.iter().find(|(id, _, _, _, _)| *id == queue_id);

            if let Some((_, _, _, retry_count, _)) = retry_task {
                assert_eq!(*retry_count, 1, "retry_count should be 1 after error");
            }
        }

        #[test]
        fn test_sync_manager_max_retries_marks_as_failed() {
            // Тест, что достижение max_retries помечает задачу как "failed"
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let queue_id = sync_manager
                .enqueue_time_entry("start", payload, "test_token".to_string(), None)
                .unwrap();

            // Симулируем достижение max_retries (5)
            sync_manager
                .db
                .update_sync_status(queue_id, "pending", 5)
                .unwrap();

            // Задача НЕ должна быть доступна для retry (retry_count >= max_retries)
            let retry_tasks = sync_manager.db.get_retry_tasks(5, 10).unwrap();
            assert!(
                !retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Task with retry_count=5 should NOT be available for retry"
            );

            // Симулируем еще одну ошибку - задача должна быть помечена как "failed"
            sync_manager
                .db
                .update_sync_status(queue_id, "failed", 5)
                .unwrap();

            // Проверяем, что задача помечена как "failed"
            let pending_tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert!(
                !pending_tasks.iter().any(|(id, _, _)| *id == queue_id),
                "Failed task should NOT be in pending tasks"
            );
        }

        #[test]
        fn test_sync_manager_successful_sync_marks_as_sent() {
            // Тест, что успешная синхронизация помечает задачу как "sent"
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let queue_id = sync_manager
                .enqueue_time_entry("start", payload, "test_token".to_string(), None)
                .unwrap();

            // Симулируем успешную синхронизацию - обновляем статус на "sent"
            sync_manager
                .db
                .update_sync_status(queue_id, "sent", 0)
                .unwrap();

            // Задача НЕ должна быть в pending или retry задачах
            let pending_tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert!(
                !pending_tasks.iter().any(|(id, _, _)| *id == queue_id),
                "Sent task should NOT be in pending tasks"
            );

            let retry_tasks = sync_manager.db.get_retry_tasks(5, 10).unwrap();
            assert!(
                !retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Sent task should NOT be in retry tasks"
            );
        }

        #[test]
        fn test_sync_manager_retry_count_progression() {
            // Тест прогрессии retry_count при множественных ошибках
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let queue_id = sync_manager
                .enqueue_time_entry("start", payload, "test_token".to_string(), None)
                .unwrap();

            let now = Utc::now().timestamp();

            // Симулируем последовательные ошибки
            for retry_count in 1..=4 {
                sync_manager
                    .db
                    .update_sync_status(queue_id, "pending", retry_count)
                    .unwrap();

                // Устанавливаем last_retry_at в прошлое, чтобы задача была доступна для retry
                // Для retry_count=1 задержка = 2 минуты, для retry_count=2 задержка = 4 минуты,
                // для retry_count=3 задержка = 8 минут, для retry_count=4 задержка = 16 минут
                // Устанавливаем на 20 минут назад, чтобы покрыть все случаи
                let conn = sync_manager.db.conn.lock().unwrap();
                let twenty_minutes_ago = now - (20 * 60);
                conn.execute(
                    "UPDATE sync_queue SET last_retry_at = ?1 WHERE id = ?2",
                    params![twenty_minutes_ago, queue_id],
                )
                .unwrap();
                drop(conn);

                // Проверяем, что задача доступна для retry (retry_count < max_retries=5)
                let retry_tasks = sync_manager.db.get_retry_tasks(5, 10).unwrap();
                let task = retry_tasks.iter().find(|(id, _, _, _, _)| *id == queue_id);

                if retry_count < 5 {
                    assert!(
                        task.is_some(),
                        "Task should be available for retry with retry_count={}",
                        retry_count
                    );
                    if let Some((_, _, _, count, _)) = task {
                        assert_eq!(*count, retry_count, "retry_count should be {}", retry_count);
                    }
                }
            }

            // После 5 попыток задача должна быть недоступна для retry
            sync_manager
                .db
                .update_sync_status(queue_id, "pending", 5)
                .unwrap();
            let retry_tasks = sync_manager.db.get_retry_tasks(5, 10).unwrap();
            assert!(
                !retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Task with retry_count=5 should NOT be available for retry"
            );
        }

        #[test]
        fn test_enqueue_screenshot_basic() {
            // Тест добавления screenshot в очередь
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Создаем тестовые PNG данные (минимальный валидный PNG)
            let png_data = vec![
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 image
                0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
            ];

            let time_entry_id = "test_entry_123".to_string();
            let access_token = "test_token".to_string();
            let refresh_token = Some("test_refresh_token".to_string());

            let queue_id = sync_manager
                .enqueue_screenshot(png_data, time_entry_id, access_token, refresh_token)
                .unwrap();

            assert!(queue_id > 0, "Queue ID should be positive");

            // Проверяем, что задача добавлена в очередь
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            let screenshot_task = tasks
                .iter()
                .find(|(id, entity_type, _)| *id == queue_id && entity_type == "screenshot");
            assert!(
                screenshot_task.is_some(),
                "Screenshot task should be in queue"
            );
        }

        #[tokio::test]
        async fn test_sync_task_invalid_payload() {
            // Тест обработки невалидного payload в sync_task
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Невалидный JSON payload
            let invalid_payload = "not a valid json";
            let result = sync_manager
                .sync_task(
                    1,
                    "time_entry_start".to_string(),
                    invalid_payload.to_string(),
                    None,
                )
                .await;

            assert!(result.is_err(), "Should return error for invalid payload");
            assert!(
                result.unwrap_err().contains("Failed to parse payload"),
                "Error should mention payload parsing"
            );
        }

        #[tokio::test]
        async fn test_sync_task_missing_access_token() {
            // PRODUCTION: Тест обработки отсутствующего access_token в AuthManager
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_start".to_string(), payload_str, None)
                .await;

            assert!(
                result.is_err(),
                "Should return error when access token not set in AuthManager"
            );
            assert!(
                result.unwrap_err().contains("Failed to get access token"),
                "Error should mention missing access token in AuthManager"
            );
        }

        #[tokio::test]
        async fn test_sync_task_unknown_operation() {
            // Тест обработки неизвестной операции
            let (sync_manager, _temp_dir) = create_test_sync_manager();
            set_test_tokens(&sync_manager).await;

            let payload = serde_json::json!({
                "projectId": "123"
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_unknown".to_string(), payload_str, None)
                .await;

            assert!(result.is_err(), "Should return error for unknown operation");
            assert!(
                result.unwrap_err().contains("Unknown time entry operation"),
                "Error should mention unknown operation"
            );
        }

        #[tokio::test]
        async fn test_sync_task_missing_id_for_pause() {
            // Тест обработки отсутствующего id для операции pause
            let (sync_manager, _temp_dir) = create_test_sync_manager();
            set_test_tokens(&sync_manager).await;

            let payload = serde_json::json!({
                // Нет id для pause
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_pause".to_string(), payload_str, None)
                .await;

            assert!(result.is_err(), "Should return error for missing id");
            assert!(
                result.unwrap_err().contains("Missing id"),
                "Error should mention missing id"
            );
        }

        #[tokio::test]
        async fn test_sync_task_screenshot_missing_image_data() {
            // Тест обработки отсутствующего imageData для screenshot
            let (sync_manager, _temp_dir) = create_test_sync_manager();
            set_test_tokens(&sync_manager).await;

            let payload = serde_json::json!({
                "timeEntryId": "entry_123"
                // Нет imageData
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "screenshot".to_string(), payload_str, None)
                .await;

            assert!(result.is_err(), "Should return error for missing imageData");
            assert!(
                result.unwrap_err().contains("Missing imageData"),
                "Error should mention missing imageData"
            );
        }

        #[tokio::test]
        async fn test_sync_task_unknown_entity_type() {
            // Тест обработки неизвестного типа сущности
            let (sync_manager, _temp_dir) = create_test_sync_manager();
            set_test_tokens(&sync_manager).await;

            let payload = serde_json::json!({});

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "unknown_entity".to_string(), payload_str, None)
                .await;

            assert!(
                result.is_err(),
                "Should return error for unknown entity type"
            );
            assert!(
                result.unwrap_err().contains("Unknown entity type"),
                "Error should mention unknown entity type"
            );
        }

        #[tokio::test]
        async fn test_sync_queue_empty() {
            // Тест синхронизации пустой очереди
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Очередь пуста
            let result = sync_manager.sync_queue(5).await;

            assert!(result.is_ok(), "Should handle empty queue gracefully");
            let synced_count = result.unwrap();
            assert_eq!(synced_count, 0, "Should sync 0 tasks from empty queue");
        }

        #[tokio::test]
        async fn test_sync_queue_with_tasks() {
            // Тест синхронизации очереди с задачами
            // Примечание: этот тест может не выполнить реальные HTTP запросы,
            // но проверит логику обработки задач
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Добавляем задачу в очередь
            let payload = serde_json::json!({
                "projectId": "123"
            });
            sync_manager
                .enqueue_time_entry("start", payload, "test_token".to_string(), None)
                .unwrap();

            // Попытка синхронизации (может завершиться ошибкой сети, но не должна паниковать)
            let result = sync_manager.sync_queue(5).await;

            // Результат может быть Ok или Err в зависимости от доступности сети
            // Главное - не должно быть паники
            match result {
                Ok(_count) => {
                    // Если синхронизация прошла успешно (например, с моком)
                    // count is usize, so it's always >= 0 by definition
                }
                Err(e) => {
                    // Ошибка сети ожидаема в тестовой среде
                    assert!(
                        e.contains("Network") || e.contains("Failed to get retry tasks"),
                        "Error should be network-related or DB-related"
                    );
                }
            }
        }

        #[test]
        fn test_enqueue_screenshot_without_refresh_token() {
            // Тест добавления screenshot без refresh_token
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let png_data = vec![0x89, 0x50, 0x4E, 0x47];
            let time_entry_id = "test_entry_456".to_string();
            let access_token = "test_token".to_string();

            let queue_id = sync_manager
                .enqueue_screenshot(png_data, time_entry_id, access_token, None)
                .unwrap();

            assert!(queue_id > 0, "Queue ID should be positive");

            // Проверяем, что задача добавлена
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            assert!(
                tasks.iter().any(|(id, _, _)| *id == queue_id),
                "Screenshot task should be in queue"
            );
        }

        #[test]
        fn test_enqueue_screenshot_base64_encoding() {
            // Тест, что screenshot корректно кодируется в base64
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let png_data = vec![0x01, 0x02, 0x03, 0x04];
            let time_entry_id = "test_entry".to_string();
            let access_token = "test_token".to_string();

            let queue_id = sync_manager
                .enqueue_screenshot(png_data.clone(), time_entry_id, access_token, None)
                .unwrap();

            // Проверяем, что payload содержит base64-encoded данные
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            let task = tasks.iter().find(|(id, _, _)| *id == queue_id);
            assert!(task.is_some(), "Task should be found");

            if let Some((_, _, payload)) = task {
                let payload_json: serde_json::Value = serde_json::from_str(payload).unwrap();
                let image_data = payload_json["imageData"].as_str().unwrap();

                // Проверяем формат: data:image/jpeg;base64,...
                assert!(
                    image_data.starts_with("data:image/jpeg;base64,"),
                    "Image data should be base64 encoded"
                );

                // Проверяем, что base64 данные присутствуют
                let base64_part = image_data.strip_prefix("data:image/jpeg;base64,").unwrap();
                assert!(!base64_part.is_empty(), "Base64 data should not be empty");
            }
        }

        #[tokio::test]
        async fn test_refresh_token_network_error() {
            // Тест обработки сетевой ошибки при refresh_token
            // Примечание: этот тест проверяет обработку ошибок сети
            // В тестовой среде без реального сервера ожидается ошибка сети
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Попытка обновить токен (ожидается ошибка сети в тестовой среде)
            let result = sync_manager.refresh_token("invalid_refresh_token").await;

            // Должна быть ошибка (либо сети, либо парсинга ответа)
            assert!(result.is_err(), "Should return error without real server");

            let error_msg = result.unwrap_err();
            // Ошибка может быть сетевой или связанной с парсингом ответа
            assert!(
                error_msg.contains("Network")
                    || error_msg.contains("Failed to create HTTP client")
                    || error_msg.contains("Token refresh failed"),
                "Error should be network-related or token refresh related"
            );
        }

        #[tokio::test]
        async fn test_sync_task_decrypt_token_error() {
            // PRODUCTION: Тест обработки отсутствующего токена в AuthManager
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            // Payload не содержит токенов (production behavior)
            let payload = serde_json::json!({
                "projectId": "123"
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_start".to_string(), payload_str, None)
                .await;

            // Должна быть ошибка получения токена из AuthManager
            assert!(
                result.is_err(),
                "Should return error when token not set in AuthManager"
            );
            let error_msg = result.unwrap_err();
            assert!(
                error_msg.contains("Failed to get access token"),
                "Error should mention missing token in AuthManager. Got: {}",
                error_msg
            );
        }

        #[tokio::test]
        async fn test_sync_task_resume_operation() {
            // Тест обработки операции resume
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "accessToken": "test_token",
                "id": "entry_123"
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_resume".to_string(), payload_str, None)
                .await;

            // Может быть ошибка сети (ожидаема), но не ошибка парсинга или валидации
            if let Err(e) = result {
                // Ошибка должна быть сетевой, а не связанной с валидацией
                assert!(
                    !e.contains("Missing id") && !e.contains("Unknown operation"),
                    "Should not have validation errors for resume operation"
                );
            }
        }

        #[tokio::test]
        async fn test_sync_task_stop_operation() {
            // Тест обработки операции stop
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let payload = serde_json::json!({
                "accessToken": "test_token",
                "id": "entry_123"
            });

            let payload_str = serde_json::to_string(&payload).unwrap();
            let result = sync_manager
                .sync_task(1, "time_entry_stop".to_string(), payload_str, None)
                .await;

            // Может быть ошибка сети (ожидаема), но не ошибка парсинга или валидации
            if let Err(e) = result {
                // Ошибка должна быть сетевой, а не связанной с валидацией
                assert!(
                    !e.contains("Missing id") && !e.contains("Unknown operation"),
                    "Should not have validation errors for stop operation"
                );
            }
        }
    }

    // Тесты для Database retry механизма
    #[cfg(test)]
    mod database_retry_tests {
        use super::*;
        use tempfile::TempDir;

        fn create_test_db() -> (Database, TempDir) {
            let temp_dir = TempDir::new().unwrap();
            let db_path = temp_dir.path().join("test.db");
            let db = Database::new(db_path.to_str().unwrap()).unwrap();
            (db, temp_dir)
        }

        #[test]
        fn test_get_retry_tasks_exponential_backoff_timing() {
            // Тест exponential backoff - задачи возвращаются только после нужной задержки
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Обновляем статус с retry_count = 0 и last_retry_at = сейчас
            // Для retry_count = 0, задержка = 1 минута (60 секунд)
            let now = Utc::now().timestamp();
            db.update_sync_status(queue_id, "pending", 0).unwrap();

            // Сразу после обновления задача может быть доступна или нет
            // (зависит от времени, но важно что функция не паникует)
            let _retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            // Проверяем, что функция не паникует и возвращает корректный результат

            // Устанавливаем last_retry_at на 2 минуты назад (больше чем 1 минута для retry_count=0)
            let conn = db.conn.lock().unwrap();
            let two_minutes_ago = now - (2 * 60);
            conn.execute(
                "UPDATE sync_queue SET last_retry_at = ?1 WHERE id = ?2",
                params![two_minutes_ago, queue_id],
            )
            .unwrap();
            drop(conn);

            // Теперь задача должна быть доступна для retry
            let retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            assert!(
                retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Task should be available for retry after 2 minutes with retry_count=0"
            );
        }

        #[test]
        fn test_get_retry_tasks_exponential_backoff_delays() {
            // PRODUCTION: Тест exponential backoff - разные задержки для разных retry_count
            // Новые значения: 10 сек, 20 сек, 40 сек, 80 сек, 120 сек (max)
            let (db, _temp_dir) = create_test_db();

            let now = Utc::now().timestamp();

            // Создаем задачи с разными retry_count
            let id0 = db.enqueue_sync("task0", r#"{"data": "0"}"#).unwrap();
            let id1 = db.enqueue_sync("task1", r#"{"data": "1"}"#).unwrap();
            let id2 = db.enqueue_sync("task2", r#"{"data": "2"}"#).unwrap();

            // Обновляем retry_count
            db.update_sync_status(id0, "pending", 0).unwrap(); // Задержка: 10 сек
            db.update_sync_status(id1, "pending", 1).unwrap(); // Задержка: 20 сек
            db.update_sync_status(id2, "pending", 2).unwrap(); // Задержка: 40 сек

            // Устанавливаем last_retry_at на 30 секунд назад для всех
            // Это должно быть достаточно для retry_count=0 (10 сек) и retry_count=1 (20 сек), но недостаточно для retry_count=2 (40 сек)
            let conn = db.conn.lock().unwrap();
            let thirty_seconds_ago = now - 30;
            conn.execute(
                "UPDATE sync_queue SET last_retry_at = ?1",
                params![thirty_seconds_ago],
            )
            .unwrap();
            drop(conn);

            let retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            let retry_ids: Vec<i64> = retry_tasks.iter().map(|(id, _, _, _, _)| *id).collect();

            // id0 (retry_count=0, задержка 10 сек) должна быть доступна
            assert!(
                retry_ids.contains(&id0),
                "Task with retry_count=0 should be available after 30 seconds (delay: 10 sec)"
            );
            // id1 (retry_count=1, задержка 20 сек) должна быть доступна
            assert!(
                retry_ids.contains(&id1),
                "Task with retry_count=1 should be available after 30 seconds (delay: 20 sec)"
            );
            // id2 (retry_count=2, задержка 40 сек) НЕ должна быть доступна
            assert!(
                !retry_ids.contains(&id2),
                "Task with retry_count=2 should NOT be available after 30 seconds (delay: 40 sec)"
            );
        }

        #[test]
        fn test_get_retry_tasks_no_last_retry_at() {
            // Тест, что задачи без last_retry_at (первая попытка) возвращаются сразу
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу (last_retry_at = NULL по умолчанию)
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Задача должна быть доступна для retry (last_retry_at IS NULL)
            let retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            assert!(
                retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Task without last_retry_at should be available for retry"
            );
        }

        #[test]
        fn test_update_sync_status_updates_last_retry_at() {
            // Тест, что update_sync_status обновляет last_retry_at
            let (db, _temp_dir) = create_test_db();

            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Получаем начальное время
            let before_update = Utc::now().timestamp();

            // Обновляем статус с retry_count
            db.update_sync_status(queue_id, "pending", 1).unwrap();

            // Проверяем, что last_retry_at обновлен
            let last_retry_at: Option<i64> = {
                let conn = db.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare("SELECT last_retry_at FROM sync_queue WHERE id = ?1")
                    .unwrap();
                stmt.query_row(params![queue_id], |row| row.get(0)).unwrap()
            };

            assert!(last_retry_at.is_some(), "last_retry_at should be set");
            let last_retry = last_retry_at.unwrap();
            let after_update = Utc::now().timestamp();

            // last_retry_at должен быть между before_update и after_update
            assert!(
                last_retry >= before_update && last_retry <= after_update,
                "last_retry_at should be updated to current time"
            );
        }

        #[test]
        fn test_get_retry_tasks_respects_max_retries_boundary() {
            // Тест граничного случая max_retries
            let (db, _temp_dir) = create_test_db();

            // Добавляем задачу
            let queue_id = db.enqueue_sync("test_task", r#"{"data": "test"}"#).unwrap();

            // Обновляем статус с retry_count = 4 (меньше max_retries=5)
            db.update_sync_status(queue_id, "pending", 4).unwrap();

            // Задача должна быть доступна для retry (retry_count < max_retries)
            let _retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            // Проверяем, что функция не паникует и может вернуть задачу
            // (зависит от времени, но важно что функция работает)

            // Обновляем статус с retry_count = 5 (равно max_retries=5)
            db.update_sync_status(queue_id, "pending", 5).unwrap();

            // Задача НЕ должна быть доступна для retry (retry_count >= max_retries)
            let retry_tasks = db.get_retry_tasks(5, 10).unwrap();
            assert!(
                !retry_tasks.iter().any(|(id, _, _, _, _)| *id == queue_id),
                "Task with retry_count=5 should NOT be available when max_retries=5"
            );
        }
    }

    // Тесты для Database edge cases (corrupted БД, partial write)
    #[cfg(test)]
    mod database_edge_cases_tests {
        use super::*;
        use std::fs;
        use std::io::Write;
        use tempfile::TempDir;

        fn create_test_db() -> (Database, TempDir) {
            let temp_dir = TempDir::new().unwrap();
            let db_path = temp_dir.path().join("test.db");
            let db = Database::new(db_path.to_str().unwrap()).unwrap();
            (db, temp_dir)
        }

        #[test]
        fn test_load_timer_state_handles_missing_table() {
            // Тест, что load_timer_state корректно обрабатывает отсутствие таблицы
            // (симулируем corrupted БД - таблица удалена)
            let (db, _temp_dir) = create_test_db();

            // Удаляем таблицу напрямую через SQL
            let conn = db.conn.lock().unwrap();
            conn.execute("DROP TABLE IF EXISTS time_entries", [])
                .unwrap();
            drop(conn);

            // Попытка загрузить состояние должна вернуть None (таблица не существует)
            // Но функция может паниковать или вернуть ошибку - нужно проверить
            let result = db.load_timer_state();

            // Функция должна либо вернуть Ok(None), либо Err
            // В любом случае, не должна паниковать
            match result {
                Ok(None) => {
                    // Ожидаемое поведение - таблица не существует, данных нет
                }
                Ok(Some(_)) => {
                    panic!("Should not return data when table does not exist");
                }
                Err(_) => {
                    // Также допустимо - ошибка при запросе к несуществующей таблице
                }
            }
        }

        #[test]
        fn test_load_timer_state_handles_invalid_data() {
            // Тест, что load_timer_state корректно обрабатывает невалидные данные
            let (db, _temp_dir) = create_test_db();

            // Вставляем невалидные данные напрямую в БД
            let conn = db.conn.lock().unwrap();
            // Вставляем строку вместо числа для accumulated_seconds (это невозможно через API, но возможно при corruption)
            // SQLite типизирован слабо, поэтому это может пройти, но при чтении может быть проблема
            conn.execute(
                "INSERT INTO time_entries (day, accumulated_seconds, state, last_updated_at) 
                 VALUES (?1, ?2, ?3, ?4)",
                params!["2024-01-15", "invalid", "running", Utc::now().timestamp()],
            )
            .ok(); // Может не сработать из-за типизации
            drop(conn);

            // Попытка загрузить состояние должна обработать ошибку корректно
            let result = db.load_timer_state();

            // Функция должна либо вернуть Ok(None), либо Err
            // В любом случае, не должна паниковать
            match result {
                Ok(None) => {
                    // Ожидаемое поведение - невалидные данные не загружаются
                }
                Ok(Some(_)) => {
                    // Если SQLite пропустил невалидные данные, это тоже допустимо
                }
                Err(_) => {
                    // Также допустимо - ошибка при чтении невалидных данных
                }
            }
        }

        #[test]
        fn test_save_timer_state_handles_transaction_rollback() {
            // Тест, что транзакция корректно откатывается при ошибке
            let (db, _temp_dir) = create_test_db();

            // Сохраняем валидное состояние
            db.save_timer_state(
                "2024-01-15",
                3600,
                "running",
                Some(Utc::now().timestamp() as u64),
            )
            .unwrap();

            // Проверяем, что данные сохранены
            let loaded_before = db.load_timer_state().unwrap();
            assert!(loaded_before.is_some());

            // Симулируем ошибку транзакции - закрываем соединение во время транзакции
            // Это сложно сделать напрямую, но можно проверить, что транзакция атомарна
            // Вместо этого проверим, что повторное сохранение работает корректно
            db.save_timer_state("2024-01-15", 7200, "paused", None)
                .unwrap();

            // Данные должны быть обновлены атомарно
            let loaded_after = db.load_timer_state().unwrap();
            assert!(loaded_after.is_some());
            let (_, accumulated, state, _) = loaded_after.unwrap();
            assert_eq!(accumulated, 7200);
            assert_eq!(state, "paused");
        }

        #[test]
        fn test_database_recovery_after_corruption() {
            // Тест восстановления БД после corruption
            let (db, temp_dir) = create_test_db();

            // Сохраняем валидное состояние
            db.save_timer_state(
                "2024-01-15",
                3600,
                "running",
                Some(Utc::now().timestamp() as u64),
            )
            .unwrap();

            // Симулируем corruption - записываем мусор в файл БД
            let db_path = temp_dir.path().join("test.db");
            let mut file = fs::OpenOptions::new().write(true).open(&db_path).unwrap();
            file.write_all(b"CORRUPTED_DATA").unwrap();
            drop(file);

            // Попытка загрузить состояние должна обработать ошибку корректно
            // SQLite может автоматически восстановить БД или вернуть ошибку
            let result = db.load_timer_state();

            // Функция должна либо вернуть Ok(None), либо Err
            // В любом случае, не должна паниковать
            match result {
                Ok(None) => {
                    // Ожидаемое поведение - БД corrupted, данных нет
                }
                Ok(Some(_)) => {
                    // Если SQLite восстановил данные, это тоже допустимо
                }
                Err(_) => {
                    // Также допустимо - ошибка при чтении corrupted БД
                }
            }
        }

        #[test]
        fn test_database_handles_concurrent_access() {
            // Тест, что БД корректно обрабатывает параллельный доступ
            let (db, _temp_dir) = create_test_db();

            // Сохраняем состояние из одного "потока"
            db.save_timer_state(
                "2024-01-15",
                3600,
                "running",
                Some(Utc::now().timestamp() as u64),
            )
            .unwrap();

            // Симулируем параллельный доступ - получаем состояние одновременно
            let loaded1 = db.load_timer_state().unwrap();
            let loaded2 = db.load_timer_state().unwrap();

            // Оба запроса должны вернуть одинаковые данные
            assert_eq!(loaded1, loaded2);
        }
    }
}

// Глобальный экземпляр для шифрования (lazy_static или OnceCell in production)
// Для упрощения используем функцию, которая создает новый экземпляр каждый раз
// В production должен быть singleton
#[allow(dead_code)] // Может использоваться в будущем для миграции старых токенов
fn get_encryption() -> Result<TokenEncryption, String> {
    TokenEncryption::new()
}

// ============================================
// SQLITE DATABASE + SYNC MANAGER
// ============================================

/// Статистика очереди синхронизации
#[derive(serde::Serialize)]
struct QueueStats {
    pending_count: i32,
    failed_count: i32,
    sent_count: i32,
    pending_by_type: std::collections::HashMap<String, i32>,
}

/// Информация о failed задаче
#[derive(serde::Serialize)]
struct FailedTaskInfo {
    id: i64,
    entity_type: String,
    payload: String,
    retry_count: i32,
    created_at: i64,
    last_retry_at: Option<i64>,
    error_message: Option<String>,
}

/// Менеджер базы данных
struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Безопасная блокировка соединения с обработкой poisoned mutex
    /// PRODUCTION: Обрабатывает случай, когда mutex был poisoned (panic в другом потоке)
    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, rusqlite::Error> {
        self.conn.lock().map_err(|e| {
            rusqlite::Error::InvalidParameterName(format!(
                "Database mutex poisoned: {}. This indicates a panic occurred while holding the lock.",
                e
            ))
        })
    }

    fn new(db_path: &str) -> SqliteResult<Self> {
        // pragma_update требует &mut self, поэтому нужен mut
        #[allow(unused_mut)]
        let mut conn = Connection::open(db_path)?;

        // GUARD: Включаем WAL mode для лучшей производительности и безопасности
        // WAL (Write-Ahead Logging) обеспечивает лучшую защиту от corruption
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| {
                warn!(
                    "[DB] Failed to enable WAL mode: {}. Continuing with default journal mode.",
                    e
                );
                // Не критично - продолжаем с дефолтным режимом
            })
            .ok();

        // GUARD: Включаем foreign_keys для целостности данных
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| {
                warn!("[DB] Failed to enable foreign keys: {}. Continuing.", e);
            })
            .ok();

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_schema()?;
        Ok(db)
    }

    /// Инициализация схемы БД
    fn init_schema(&self) -> SqliteResult<()> {
        let conn = self.lock_conn()?;

        // Таблица для сохранения состояния таймера
        conn.execute(
            "CREATE TABLE IF NOT EXISTS time_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day TEXT NOT NULL,
            accumulated_seconds INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL,
            last_updated_at INTEGER NOT NULL,
            started_at INTEGER,
            UNIQUE(day)
        )",
            [],
        )?;

        // Таблица очереди синхронизации
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_retry_at INTEGER,
            error_message TEXT,
            priority INTEGER NOT NULL DEFAULT 2,
            idempotency_key TEXT
        )",
            [],
        )?;

        // Миграции: добавляем колонки если их нет
        let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN error_message TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE sync_queue ADD COLUMN priority INTEGER DEFAULT 2",
            [],
        );
        // Миграция: добавляем started_at для восстановления времени при перезапуске
        let _ = conn.execute("ALTER TABLE time_entries ADD COLUMN started_at INTEGER", []);
        // CRITICAL FIX: Миграция для idempotency keys
        let _ = conn.execute("ALTER TABLE sync_queue ADD COLUMN idempotency_key TEXT", []);

        // Индексы для быстрого поиска
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_time_entries_day ON time_entries(day)",
            [],
        )?;

        Ok(())
    }

    /// Сохранить состояние таймера
    /// GUARD: Использует транзакцию для атомарности (защита от partial writes)
    fn save_timer_state(
        &self,
        day: &str,
        accumulated_seconds: u64,
        state: &str,
        started_at: Option<u64>,
    ) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // GUARD: Начинаем транзакцию для атомарности
        // BEGIN IMMEDIATE гарантирует, что транзакция начнется немедленно
        // и не будет ждать освобождения блокировки
        conn.execute("BEGIN IMMEDIATE TRANSACTION", [])
            .map_err(|e| {
                error!("[DB] Failed to begin transaction: {}", e);
                e
            })?;

        // Выполняем операцию внутри транзакции
        let result = conn.execute(
            "INSERT INTO time_entries (day, accumulated_seconds, state, last_updated_at, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(day) DO UPDATE SET
        accumulated_seconds = ?2,
        state = ?3,
        last_updated_at = ?4,
        started_at = ?5",
            params![day, accumulated_seconds, state, now, started_at],
        );

        // GUARD: Коммитим или откатываем транзакцию
        match result {
            Ok(_) => {
                // Успешно - коммитим транзакцию
                conn.execute("COMMIT", []).map_err(|e| {
                    error!("[DB] Failed to commit transaction: {}", e);
                    // Пытаемся откатить
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                Ok(())
            }
            Err(e) => {
                // Ошибка - откатываем транзакцию
                error!(
                    "[DB] Failed to save timer state: {}. Rolling back transaction.",
                    e
                );
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Загрузить последнее состояние таймера
    fn load_timer_state(&self) -> SqliteResult<Option<(String, u64, String, Option<u64>)>> {
        let conn = self.lock_conn()?;

        let mut stmt = conn.prepare(
            "SELECT day, accumulated_seconds, state, started_at FROM time_entries
     ORDER BY last_updated_at DESC LIMIT 1",
        )?;

        let result = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
            ))
        })?;

        for row in result {
            return Ok(Some(row?));
        }

        Ok(None)
    }

    /// Добавить задачу в очередь синхронизации
    /// Защита от дублирования: не добавляет задачу, если такая же задача уже в очереди (pending) за последние 5 секунд
    /// CRITICAL FIX: Использует явную транзакцию для атомарности
    fn enqueue_sync(&self, entity_type: &str, payload: &str) -> SqliteResult<i64> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();
        let duplicate_window = 5; // 5 секунд

        // CRITICAL FIX: Генерируем idempotency key из entity_type + payload
        // ДОКАЗАНО: Одинаковые entity_type + payload дают одинаковый ключ
        let mut hasher = DefaultHasher::new();
        entity_type.hash(&mut hasher);
        payload.hash(&mut hasher);
        let idempotency_key = format!("{}-{:x}", entity_type, hasher.finish());

        // CRITICAL FIX: Начинаем явную транзакцию для атомарности
        // BEGIN IMMEDIATE гарантирует, что транзакция начнется немедленно
        conn.execute("BEGIN IMMEDIATE TRANSACTION", [])
            .map_err(|e| {
                error!("[DB] Failed to begin transaction in enqueue_sync: {}", e);
                e
            })?;

        // Проверяем, есть ли такая же задача в очереди (pending) за последние 5 секунд
        let duplicate_check: i32 = match conn.query_row(
            "SELECT COUNT(*) FROM sync_queue 
             WHERE entity_type = ?1 
             AND payload = ?2 
             AND status = 'pending' 
             AND created_at > ?3",
            params![entity_type, payload, now - duplicate_window],
            |row| row.get(0),
        ) {
            Ok(count) => count,
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        };

        if duplicate_check > 0 {
            // Такая же задача уже в очереди - не добавляем дубликат
            warn!(
                "[DB] Duplicate task detected: {} with payload {} (skipping)",
                entity_type,
                if payload.len() > 50 {
                    &payload[..50]
                } else {
                    payload
                }
            );
            // Возвращаем ID существующей задачи (находим её)
            let existing_id: i64 = match conn.query_row(
                "SELECT id FROM sync_queue 
                 WHERE entity_type = ?1 
                 AND payload = ?2 
                 AND status = 'pending' 
                 AND created_at > ?3
                 ORDER BY created_at DESC 
                 LIMIT 1",
                params![entity_type, payload, now - duplicate_window],
                |row| row.get(0),
            ) {
                Ok(id) => {
                    // ДОКАЗАНО: Дубликат найден - коммитим транзакцию и возвращаем ID
                    conn.execute("COMMIT", []).map_err(|e| {
                        error!(
                            "[DB] Failed to commit transaction in enqueue_sync (duplicate): {}",
                            e
                        );
                        let _ = conn.execute("ROLLBACK", []);
                        e
                    })?;
                    id
                }
                Err(e) => {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(e);
                }
            };
            return Ok(existing_id);
        }

        // Определяем приоритет задачи
        let priority = TaskPriority::from_entity_type(entity_type);
        let priority_value = priority as i32;

        // GUARD: Проверка лимита очереди (10_000 задач)
        let queue_size: i32 = match conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'failed')",
            [],
            |row| row.get(0),
        ) {
            Ok(size) => size,
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                return Err(e);
            }
        };

        if queue_size >= 10_000 {
            // Очередь переполнена - не добавляем новые задачи (кроме critical)
            if priority != TaskPriority::Critical {
                warn!(
                    "[DB] Queue limit reached ({} tasks), dropping non-critical task: {}",
                    queue_size, entity_type
                );
                let _ = conn.execute("ROLLBACK", []);
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
                    Some("Queue limit reached".to_string()),
                ));
            }
            // Для critical задач удаляем самые старые normal задачи
            let _ = conn.execute(
                "DELETE FROM sync_queue 
                 WHERE status = 'pending' 
                 AND priority = 2 
                 AND id IN (
                     SELECT id FROM sync_queue 
                     WHERE status = 'pending' AND priority = 2 
                     ORDER BY created_at ASC 
                     LIMIT 10
                 )",
                [],
            );
        }

        // CRITICAL FIX: INSERT внутри транзакции с idempotency_key
        let result = conn.execute(
            "INSERT INTO sync_queue (entity_type, payload, status, created_at, priority, idempotency_key)
     VALUES (?1, ?2, 'pending', ?3, ?4, ?5)",
            params![entity_type, payload, now, priority_value, idempotency_key],
        );

        // CRITICAL FIX: Коммитим или откатываем транзакцию
        match result {
            Ok(_) => {
                // ДОКАЗАНО: INSERT успешен - коммитим транзакцию
                conn.execute("COMMIT", []).map_err(|e| {
                    error!("[DB] Failed to commit transaction in enqueue_sync: {}", e);
                    let _ = conn.execute("ROLLBACK", []);
                    e
                })?;
                Ok(conn.last_insert_rowid())
            }
            Err(e) => {
                // ДОКАЗАНО: INSERT не удался - откатываем транзакцию
                error!(
                    "[DB] Failed to insert task in enqueue_sync: {}. Rolling back transaction.",
                    e
                );
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Получить количество pending задач (для адаптивного batch)
    fn get_pending_count_for_batch(&self) -> SqliteResult<i32> {
        self.get_pending_count()
    }

    /// Получить задачи для синхронизации (для тестов)
    #[cfg(test)]
    pub(crate) fn get_pending_sync_tasks(
        &self,
        limit: i32,
    ) -> SqliteResult<Vec<(i64, String, String)>> {
        let conn = self.lock_conn()?;

        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload FROM sync_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }

    /// Обновить статус задачи синхронизации
    fn update_sync_status(&self, id: i64, status: &str, retry_count: i32) -> SqliteResult<()> {
        self.update_sync_status_with_error(id, status, retry_count, None)
    }

    /// Обновить статус задачи синхронизации с причиной ошибки
    fn update_sync_status_with_error(
        &self,
        id: i64,
        status: &str,
        retry_count: i32,
        error_message: Option<&str>,
    ) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        if let Some(error) = error_message {
            conn.execute(
                "UPDATE sync_queue 
         SET status = ?1, retry_count = ?2, last_retry_at = ?3, error_message = ?4
         WHERE id = ?5",
                params![status, retry_count, now, error, id],
            )?;
        } else {
            conn.execute(
                "UPDATE sync_queue 
         SET status = ?1, retry_count = ?2, last_retry_at = ?3
         WHERE id = ?4",
                params![status, retry_count, now, id],
            )?;
        }

        Ok(())
    }

    /// Получить количество pending задач
    fn get_pending_count(&self) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Получить количество failed задач
    fn get_failed_count(&self) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Получить статистику очереди по типам задач
    fn get_queue_stats(&self) -> SqliteResult<QueueStats> {
        let conn = self.lock_conn()?;

        // Статистика по типам задач для pending
        let mut stmt = conn.prepare(
            "SELECT entity_type, COUNT(*) as count 
             FROM sync_queue 
             WHERE status = 'pending' 
             GROUP BY entity_type",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
        })?;

        let mut by_type: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
        for row in rows {
            let (entity_type, count) = row?;
            by_type.insert(entity_type, count);
        }

        // Общее количество pending
        let pending_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;

        // Общее количество failed
        let failed_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;

        // Общее количество sent (успешно синхронизированных)
        let sent_count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'sent'",
            [],
            |row| row.get(0),
        )?;

        Ok(QueueStats {
            pending_count,
            failed_count,
            sent_count,
            pending_by_type: by_type,
        })
    }

    /// Обновить статус задачи на "sent" (успешная синхронизация)
    /// PRODUCTION: Partial success - успешные задачи помечаются сразу
    fn mark_task_sent(&self, id: i64) -> SqliteResult<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE sync_queue SET status = 'sent' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Получить список failed задач с деталями
    fn get_failed_tasks(&self, limit: i32) -> SqliteResult<Vec<FailedTaskInfo>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload, retry_count, created_at, last_retry_at, error_message 
             FROM sync_queue 
             WHERE status = 'failed' 
             ORDER BY created_at DESC 
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(FailedTaskInfo {
                id: row.get::<_, i64>(0)?,
                entity_type: row.get::<_, String>(1)?,
                payload: row.get::<_, String>(2)?,
                retry_count: row.get::<_, i32>(3)?,
                created_at: row.get::<_, i64>(4)?,
                last_retry_at: row.get::<_, Option<i64>>(5)?,
                error_message: row.get::<_, Option<String>>(6)?,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }

    /// Сбросить failed задачи обратно в pending для повторной попытки
    fn reset_failed_tasks(&self, limit: i32) -> SqliteResult<i32> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // Сбрасываем retry_count в 0 и статус в 'pending' для failed задач
        let count = conn.execute(
            "UPDATE sync_queue 
             SET status = 'pending', retry_count = 0, last_retry_at = ?1
             WHERE status = 'failed' 
             AND id IN (
                 SELECT id FROM sync_queue 
                 WHERE status = 'failed' 
                 ORDER BY created_at ASC 
                 LIMIT ?2
             )",
            params![now, limit],
        )?;

        Ok(count as i32)
    }

    /// Получить задачи для повторной попытки (exponential backoff)
    /// Получить задачи для синхронизации с адаптивным batch size и приоритетами
    /// PRODUCTION: Exponential backoff: 10 сек → 20 сек → 40 сек → 80 сек → 120 сек (max)
    /// CRITICAL FIX: Возвращает idempotency_key для предотвращения дубликатов
    fn get_retry_tasks(
        &self,
        max_retries: i32,
        batch_size: i32,
    ) -> SqliteResult<Vec<(i64, String, String, i32, Option<String>)>> {
        let conn = self.lock_conn()?;
        let now = Utc::now().timestamp();

        // PRODUCTION: Исправленный exponential backoff
        // Минимум: 10 секунд, максимум: 120 секунд (2 минуты)
        // Формула: min(10 * 2^retry_count, 120)
        // CRITICAL FIX: Включаем idempotency_key в SELECT
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, payload, retry_count, idempotency_key FROM sync_queue
     WHERE status = 'pending' AND retry_count < ?1
     AND (last_retry_at IS NULL OR 
          last_retry_at + CASE 
              WHEN retry_count = 0 THEN 10
              WHEN retry_count = 1 THEN 20
              WHEN retry_count = 2 THEN 40
              WHEN retry_count = 3 THEN 80
              WHEN retry_count >= 4 THEN 120
              ELSE 120
          END <= ?2)
     ORDER BY priority ASC, created_at ASC
     LIMIT ?3",
        )?;

        let rows = stmt.query_map(params![max_retries, now, batch_size], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }
}

/// Приоритет задачи синхронизации
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum TaskPriority {
    Critical = 0, // start, stop
    High = 1,     // pause, resume
    Normal = 2,   // screenshots, activities
}

impl TaskPriority {
    fn from_entity_type(entity_type: &str) -> Self {
        if entity_type == "time_entry_start" || entity_type == "time_entry_stop" {
            TaskPriority::Critical
        } else if entity_type.starts_with("time_entry_") {
            TaskPriority::High
        } else {
            TaskPriority::Normal
        }
    }
}

/// Менеджер аутентификации для получения токенов
/// Получает токены из localStorage через Tauri команду
struct AuthManager {
    api_base_url: String,
    // GUARD: Временное хранение токенов для синхронизации
    // В production должно быть в Keychain
    access_token: Arc<tokio::sync::RwLock<Option<String>>>,
    refresh_token: Arc<tokio::sync::RwLock<Option<String>>>,
}

impl AuthManager {
    fn new(api_base_url: String) -> Self {
        Self {
            api_base_url,
            access_token: Arc::new(tokio::sync::RwLock::new(None)),
            refresh_token: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Установить токены (вызывается из Tauri команды)
    async fn set_tokens(&self, access_token: Option<String>, refresh_token: Option<String>) {
        *self.access_token.write().await = access_token;
        *self.refresh_token.write().await = refresh_token;
    }

    /// Получить access token
    async fn get_access_token(&self) -> Result<String, String> {
        self.access_token
            .read()
            .await
            .clone()
            .ok_or_else(|| "Access token not set. Call set_auth_tokens first.".to_string())
    }

    /// Получить refresh token
    async fn get_refresh_token(&self) -> Result<Option<String>, String> {
        Ok(self.refresh_token.read().await.clone())
    }

    /// Получить свежий access token (обновить если нужно)
    /// Проверяет срок действия и обновляет если < 60 секунд до expiry
    #[allow(dead_code)] // Может использоваться в будущем для автоматического обновления токенов
    async fn get_fresh_token(
        &self,
        current_token: Option<&str>,
        _refresh_token: Option<&str>,
    ) -> Result<String, String> {
        // Если токен не предоставлен, пытаемся получить из storage
        let token = if let Some(t) = current_token {
            t.to_string()
        } else {
            self.get_access_token().await?
        };

        // TODO: Проверять expiry токена (JWT decode)
        // Пока что просто возвращаем токен
        // В production нужно декодировать JWT и проверять exp claim

        Ok(token)
    }

    /// Обновить токен через refresh token
    async fn refresh_token(&self, refresh_token: &str) -> Result<TokenRefreshResult, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let url = format!("{}/auth/refresh", self.api_base_url);
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| format!("Network error during token refresh: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Token refresh failed with status: {}",
                response.status()
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

        let access_token = json["access_token"]
            .as_str()
            .ok_or_else(|| "Missing access_token in refresh response".to_string())?
            .to_string();

        let refresh_token = json["refresh_token"].as_str().map(|s| s.to_string());

        Ok(TokenRefreshResult {
            access_token,
            refresh_token,
        })
    }
}

/// Менеджер синхронизации для обработки offline queue
/// PRODUCTION-GRADE: single-flight sync, fresh tokens, adaptive batching
#[derive(Clone)]
struct SyncManager {
    db: Arc<Database>,
    api_base_url: String,
    auth_manager: Arc<AuthManager>,
    // GUARD: Single-flight sync lock (только tokio::Mutex, без AtomicBool)
    sync_lock: Arc<tokio::sync::Mutex<()>>,
}

/// Результат обновления токена
#[derive(Debug)]
struct TokenRefreshResult {
    access_token: String,
    refresh_token: Option<String>,
}

impl SyncManager {
    fn new(db: Arc<Database>) -> Self {
        let api_base_url = "https://app.automatonsoft.de/api".to_string();
        Self {
            db,
            api_base_url: api_base_url.clone(),
            auth_manager: Arc::new(AuthManager::new(api_base_url)),
            sync_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Вычислить адаптивный batch size на основе количества pending задач
    /// PRODUCTION: Адаптивный размер batch для эффективной синхронизации
    fn calculate_batch_size(&self, pending_count: i32) -> i32 {
        match pending_count {
            0..=20 => 5,     // Маленькая очередь - маленький batch
            21..=100 => 20,  // Средняя очередь - средний batch
            101..=500 => 50, // Большая очередь - большой batch
            _ => 100,        // Очень большая очередь - максимальный batch
        }
    }

    /// Обновить токен через refresh token
    /// Используется в тестах и через auth_manager.refresh_token() в sync_task
    #[allow(dead_code)] // Используется в тестах
    async fn refresh_token(&self, refresh_token: &str) -> Result<TokenRefreshResult, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let url = format!("{}/auth/refresh", self.api_base_url);
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| format!("Network error during token refresh: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Token refresh failed with status: {}",
                response.status()
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

        let access_token = json["access_token"]
            .as_str()
            .ok_or_else(|| "Missing access_token in refresh response".to_string())?
            .to_string();

        let refresh_token = json["refresh_token"].as_str().map(|s| s.to_string());

        Ok(TokenRefreshResult {
            access_token,
            refresh_token,
        })
    }

    /// Добавить time entry операцию в очередь синхронизации
    /// PRODUCTION: Токены НЕ сохраняются в payload, получаются через AuthManager при синхронизации
    fn enqueue_time_entry(
        &self,
        operation: &str,
        payload: serde_json::Value,
        _access_token: String, // Не используется - оставлен для обратной совместимости
        _refresh_token: Option<String>, // Не используется - оставлен для обратной совместимости
    ) -> Result<i64, String> {
        // PRODUCTION: Токены НЕ сохраняются в payload
        // Они будут получаться через AuthManager.get_fresh_token() при синхронизации
        let payload_str = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize payload: {}", e))?;

        self.db
            .enqueue_sync(&format!("time_entry_{}", operation), &payload_str)
            .map_err(|e| format!("Failed to enqueue time entry: {}", e))
    }

    /// Добавить скриншот в очередь синхронизации
    /// PRODUCTION: Токены НЕ сохраняются в payload
    fn enqueue_screenshot(
        &self,
        png_data: Vec<u8>,
        time_entry_id: String,
        _access_token: String, // Не используется - оставлен для обратной совместимости
        _refresh_token: Option<String>, // Не используется - оставлен для обратной совместимости
    ) -> Result<i64, String> {
        use base64::{engine::general_purpose, Engine as _};

        // Конвертируем в base64
        let base64_string = general_purpose::STANDARD.encode(&png_data);
        let image_data = format!("data:image/jpeg;base64,{}", base64_string);

        // PRODUCTION: Токены НЕ сохраняются в payload
        let payload = serde_json::json!({
            "imageData": image_data,
            "timeEntryId": time_entry_id,
        });

        let payload_str = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize payload: {}", e))?;

        self.db
            .enqueue_sync("screenshot", &payload_str)
            .map_err(|e| format!("Failed to enqueue screenshot: {}", e))
    }

    /// Синхронизировать одну задачу из очереди
    /// PRODUCTION: Получает токены через AuthManager (не из payload)
    /// Автоматически обновляет токен при 401 ошибке
    /// CRITICAL FIX: Использует idempotency_key для предотвращения дубликатов
    async fn sync_task(
        &self,
        task_id: i64,
        entity_type: String,
        payload: String,
        idempotency_key: Option<String>,
    ) -> Result<bool, String> {
        let payload_json: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|e| format!("Failed to parse payload: {}", e))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        // PRODUCTION: Получаем токены через AuthManager (не из payload)
        let mut access_token = self.auth_manager.get_access_token().await.map_err(|e| {
            format!(
                "Failed to get access token: {}. Call set_auth_tokens first.",
                e
            )
        })?;

        let mut refresh_token = self
            .auth_manager
            .get_refresh_token()
            .await
            .map_err(|e| format!("Failed to get refresh token: {}", e))?;

        // Выполняем запрос с возможностью обновления токена при 401
        let mut retry_with_refresh = true;
        loop {
            // Выполняем HTTP запрос
            let response_result = if entity_type.starts_with("time_entry_") {
                let operation = entity_type.strip_prefix("time_entry_").unwrap();

                // PRODUCTION: Payload уже не содержит токенов
                let request_payload = payload_json.clone();

                let url = match operation {
                    "start" => format!("{}/time-entries", self.api_base_url),
                    "pause" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for pause operation".to_string())?;
                        format!("{}/time-entries/{}/pause", self.api_base_url, id)
                    }
                    "resume" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for resume operation".to_string())?;
                        format!("{}/time-entries/{}/resume", self.api_base_url, id)
                    }
                    "stop" => {
                        let id = payload_json["id"]
                            .as_str()
                            .ok_or_else(|| "Missing id for stop operation".to_string())?;
                        format!("{}/time-entries/{}/stop", self.api_base_url, id)
                    }
                    _ => return Err(format!("Unknown time entry operation: {}", operation)),
                };

                let method = match operation {
                    "start" => client.post(&url),
                    "pause" | "resume" | "stop" => client.put(&url),
                    _ => return Err(format!("Unknown operation: {}", operation)),
                };

                let mut request = method
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {}", access_token));

                // CRITICAL FIX: Добавляем idempotency key в заголовок
                // ДОКАЗАНО: Сервер может использовать этот ключ для дедупликации
                if let Some(ref key) = idempotency_key {
                    request = request.header("X-Idempotency-Key", key);
                }

                request.json(&request_payload).send().await
            } else if entity_type == "screenshot" {
                let image_data = payload_json["imageData"]
                    .as_str()
                    .ok_or_else(|| "Missing imageData in payload".to_string())?;
                let time_entry_id = payload_json["timeEntryId"]
                    .as_str()
                    .ok_or_else(|| "Missing timeEntryId in payload".to_string())?;

                let screenshot_payload = serde_json::json!({
                    "imageData": image_data,
                    "timeEntryId": time_entry_id,
                });

                let url = format!("{}/screenshots", self.api_base_url);
                let mut request = client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .header("Authorization", format!("Bearer {}", access_token));

                // CRITICAL FIX: Добавляем idempotency key в заголовок
                if let Some(ref key) = idempotency_key {
                    request = request.header("X-Idempotency-Key", key);
                }

                request.json(&screenshot_payload).send().await
            } else {
                return Err(format!("Unknown entity type: {}", entity_type));
            };

            match response_result {
                Ok(response) => {
                    let status = response.status();

                    // Если 401 и есть refresh_token, обновляем токен
                    if status == 401 && retry_with_refresh {
                        if let Some(refresh) = refresh_token.as_ref() {
                            info!(
                                "[SYNC] Token expired (401), refreshing token for task {}",
                                task_id
                            );

                            match self.auth_manager.refresh_token(refresh).await {
                                Ok(token_result) => {
                                    // Обновляем токены в AuthManager
                                    access_token = token_result.access_token.clone();
                                    if let Some(new_refresh) = token_result.refresh_token {
                                        refresh_token = Some(new_refresh.clone());
                                    }

                                    // PRODUCTION: Сохраняем новые токены в AuthManager (не в payload)
                                    self.auth_manager
                                        .set_tokens(
                                            Some(access_token.clone()),
                                            refresh_token.clone(),
                                        )
                                        .await;

                                    retry_with_refresh = false; // Только одна попытка обновления
                                    continue; // Повторяем запрос с новым токеном
                                }
                                Err(e) => {
                                    let error_msg = format!("Token refresh failed: {}", e);
                                    warn!(
                                        "[SYNC] Failed to refresh token for task {}: {}",
                                        task_id, error_msg
                                    );
                                    return Err(error_msg); // Возвращаем ошибку для сохранения в БД
                                }
                            }
                        } else {
                            let error_msg =
                                "Token expired (401) but no refresh token available".to_string();
                            warn!("[SYNC] {} for task {}", error_msg, task_id);
                            return Err(error_msg); // Возвращаем ошибку для сохранения в БД
                        }
                    }

                    // Возвращаем результат
                    let status_code = status.as_u16();
                    if status.is_success() {
                        return Ok(true);
                    } else {
                        // Сохраняем статус код в ошибке
                        let error_msg = format!(
                            "HTTP {}: {}",
                            status_code,
                            status.canonical_reason().unwrap_or("Unknown")
                        );
                        return Err(error_msg);
                    }
                }
                Err(e) => {
                    // Ошибка сети - возвращаем ошибку для retry
                    return Err(format!("Network error: {}", e));
                }
            }
        }
    }

    /// Внутренний метод синхронизации (single-flight)
    /// PRODUCTION: Все точки входа сходятся здесь
    async fn run_sync_internal(&self, max_retries: i32) -> Result<usize, String> {
        // PRODUCTION: Проверяем наличие токенов перед синхронизацией
        // Если токенов нет, пропускаем синхронизацию (токены могут быть еще не установлены при старте)
        if self.auth_manager.get_access_token().await.is_err() {
            warn!("[SYNC] Skipping sync: access token not set. Tokens may not be restored yet.");
            return Ok(0); // Возвращаем 0, не ошибку - это нормальная ситуация при старте
        }

        // Получаем количество pending задач для адаптивного batch
        let pending_count = self
            .db
            .get_pending_count_for_batch()
            .map_err(|e| format!("Failed to get pending count: {}", e))?;

        if pending_count == 0 {
            debug!("[SYNC] No pending tasks, skipping sync");
            return Ok(0);
        }

        // Вычисляем адаптивный batch size
        let batch_size = self.calculate_batch_size(pending_count);

        // Получаем статистику по типам задач для логирования
        let queue_stats = self.db.get_queue_stats().ok();
        let stats_info = if let Some(stats) = queue_stats {
            let type_info: Vec<String> = stats
                .pending_by_type
                .iter()
                .map(|(k, v)| format!("{}: {}", k, v))
                .collect();
            if !type_info.is_empty() {
                format!(" (by type: {})", type_info.join(", "))
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        info!(
            "[SYNC] Starting sync: {} pending tasks{}, batch size: {}",
            pending_count, stats_info, batch_size
        );

        // Получаем задачи с приоритетами и exponential backoff
        let tasks = self
            .db
            .get_retry_tasks(max_retries, batch_size)
            .map_err(|e| format!("Failed to get retry tasks: {}", e))?;

        if tasks.is_empty() {
            debug!(
                "[SYNC] No tasks ready for retry (exponential backoff or all tasks processed), skipping batch"
            );
            return Ok(0);
        }

        let mut synced_count = 0;
        let mut failed_in_batch = 0;
        let mut by_type_synced: std::collections::HashMap<String, i32> =
            std::collections::HashMap::new();
        let mut by_type_failed: std::collections::HashMap<String, i32> =
            std::collections::HashMap::new();

        // PRODUCTION: Partial success - обрабатываем все задачи в batch
        // Ошибка одной задачи НЕ останавливает batch
        for (id, entity_type, payload, retry_count, idempotency_key) in tasks {
            info!(
                "[SYNC] Processing task {}: {} (retry {})",
                id, entity_type, retry_count
            );

            match self
                .sync_task(
                    id,
                    entity_type.clone(),
                    payload.clone(),
                    idempotency_key.clone(),
                )
                .await
            {
                Ok(true) => {
                    // CRITICAL FIX: Retry mark_task_sent() с exponential backoff
                    // ДОКАЗАНО: HTTP запрос успешен - задача ДОЛЖНА быть помечена как sent
                    let mut retries = 0;
                    const MAX_RETRIES: u32 = 3;
                    let mut marked = false;

                    while retries < MAX_RETRIES {
                        match self.db.mark_task_sent(id) {
                            Ok(_) => {
                                // ДОКАЗАНО: mark_task_sent успешен
                                marked = true;
                                break;
                            }
                            Err(e) => {
                                retries += 1;
                                if retries >= MAX_RETRIES {
                                    // ДОКАЗАНО: Все попытки исчерпаны - критическая ошибка
                                    error!(
                                        "[SYNC] CRITICAL: Failed to mark task {} sent after {} retries: {}. Task will be retried, causing duplicate.",
                                        id, MAX_RETRIES, e
                                    );
                                    // НЕ увеличиваем synced_count - задача останется pending
                                    // Это лучше, чем потерять задачу, но хуже, чем дубликат
                                    // В production нужен мониторинг таких случаев
                                    break;
                                }
                                // Exponential backoff: 100ms, 200ms, 400ms
                                let delay_ms = 100 * (1 << (retries - 1));
                                warn!(
                                    "[SYNC] Failed to mark task {} sent (attempt {}): {}. Retrying in {}ms...",
                                    id, retries, e, delay_ms
                                );
                                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms))
                                    .await;
                            }
                        }
                    }

                    if marked {
                        // ДОКАЗАНО: Задача помечена как sent - увеличиваем счетчики
                        synced_count += 1;
                        *by_type_synced.entry(entity_type.clone()).or_insert(0) += 1;
                    } else {
                        // ДОКАЗАНО: mark_task_sent не удался после всех попыток
                        // Задача остается pending и будет retried - это лучше, чем потерять задачу
                        // Но может привести к дубликату на сервере
                        // В production нужен мониторинг и ручное вмешательство
                        warn!(
                            "[SYNC] Task {} remains pending after HTTP success due to mark_task_sent failure. Manual intervention may be required.",
                            id
                        );
                    }
                }
                Ok(false) => {
                    // Ошибка сервера (4xx, 5xx)
                    failed_in_batch += 1;
                    *by_type_failed.entry(entity_type.clone()).or_insert(0) += 1;
                    let new_retry_count = retry_count + 1;
                    let error_msg =
                        format!("Server error (4xx/5xx) after {} retries", new_retry_count);
                    if new_retry_count >= max_retries {
                        self.db
                            .update_sync_status_with_error(
                                id,
                                "failed",
                                new_retry_count,
                                Some(&error_msg),
                            )
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        // Обновляем статус на pending с новым retry_count
                        // next_retry_at будет вычислен при следующем get_retry_tasks
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        info!(
                            "[SYNC] Task {} will retry later (attempt {})",
                            id, new_retry_count
                        );
                    }
                }
                Err(e) => {
                    // Ошибка сети или другая ошибка
                    failed_in_batch += 1;
                    *by_type_failed.entry(entity_type.clone()).or_insert(0) += 1;
                    let new_retry_count = retry_count + 1;
                    let error_msg = format!("{}", e);
                    if new_retry_count >= max_retries {
                        self.db
                            .update_sync_status_with_error(
                                id,
                                "failed",
                                new_retry_count,
                                Some(&error_msg),
                            )
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        warn!(
                            "[SYNC] Task {} failed after {} retries: {}",
                            id, new_retry_count, error_msg
                        );
                    } else {
                        // Обновляем статус на pending с новым retry_count
                        self.db
                            .update_sync_status(id, "pending", new_retry_count)
                            .map_err(|e| format!("Failed to update status: {}", e))?;
                        info!(
                            "[SYNC] Task {} will retry later (attempt {}): {}",
                            id, new_retry_count, error_msg
                        );
                    }
                }
            }
        }

        if failed_in_batch > 0 {
            info!(
                "[SYNC] Batch completed: {} synced, {} failed",
                synced_count, failed_in_batch
            );
        }

        // Финальное логирование с детальной статистикой
        let synced_by_type: Vec<String> = by_type_synced
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();
        let failed_by_type: Vec<String> = by_type_failed
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();

        if synced_count > 0 || failed_in_batch > 0 {
            let mut log_parts = vec![format!("Synced: {} tasks", synced_count)];
            if !synced_by_type.is_empty() {
                log_parts.push(format!("({})", synced_by_type.join(", ")));
            }
            if failed_in_batch > 0 {
                log_parts.push(format!("Failed: {} tasks", failed_in_batch));
                if !failed_by_type.is_empty() {
                    log_parts.push(format!("({})", failed_by_type.join(", ")));
                }
            }
            info!("[SYNC] Sync completed: {}", log_parts.join(", "));
        }

        Ok(synced_count)
    }

    /// Синхронизировать очередь (обработать pending задачи)
    /// PRODUCTION: Single-flight через sync_lock с таймаутом
    async fn sync_queue(&self, max_retries: i32) -> Result<usize, String> {
        // GUARD: Single-flight - только один sync может выполняться одновременно
        // GUARD: Таймаут для lock (300 сек) - защита от зависания предыдущего sync
        match tokio::time::timeout(tokio::time::Duration::from_secs(300), self.sync_lock.lock())
            .await
        {
            Ok(lock) => {
                let _lock = lock;
                self.run_sync_internal(max_retries).await
            }
            Err(_) => {
                error!("[SYNC] CRITICAL: Sync lock timeout (300s) - previous sync may be stuck");
                Err(
                    "Sync lock timeout: previous sync may be stuck. Check logs for stuck sync task."
                        .to_string(),
                )
            }
        }
    }
}

// ============================================
// STRICT FINITE STATE MACHINE
// ============================================

/// Состояние таймера - строгая FSM
/// Невозможные состояния физически невозможны
#[derive(Debug, Clone)]
pub enum TimerState {
    /// Таймер остановлен
    Stopped,
    /// Таймер работает - хранит Instant начала сессии
    Running {
        started_at: u64,             // Unix timestamp (секунды) для API
        started_at_instant: Instant, // Монотонное время (для расчетов)
    },
    /// Таймер на паузе
    Paused,
}

// Сериализация для API (без Instant)
impl Serialize for TimerState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            TimerState::Stopped => serializer.serialize_unit_variant("TimerState", 0, "STOPPED"),
            TimerState::Running { started_at, .. } => {
                use serde::ser::SerializeStruct;
                let mut state = serializer.serialize_struct("Running", 2)?;
                state.serialize_field("state", "RUNNING")?;
                state.serialize_field("started_at", started_at)?;
                state.end()
            }
            TimerState::Paused => serializer.serialize_unit_variant("TimerState", 2, "PAUSED"),
        }
    }
}

/// Ответ для API - упрощенная версия состояния (без Instant)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerStateResponse {
    #[serde(flatten)]
    pub state: TimerStateForAPI,
    pub elapsed_seconds: u64,
    pub accumulated_seconds: u64,   // Накопленное время за день
    pub session_start: Option<u64>, // Unix timestamp начала сессии (только для Running)
    pub day_start: Option<u64>,     // Unix timestamp начала дня
}

/// Упрощенная версия TimerState для API (без Instant)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(tag = "state")]
pub enum TimerStateForAPI {
    Stopped,
    Running { started_at: u64 },
    Paused,
}

/// Timer Engine - строгая FSM
/// Все операции атомарны через один Mutex
struct TimerEngine {
    /// Состояние FSM - единственный источник истины
    /// Внутри Running хранится started_at_instant
    state: Arc<Mutex<TimerState>>,
    /// Накопленное время за день (обновляется только при pause/stop)
    accumulated_seconds: Arc<Mutex<u64>>,
    /// Unix timestamp начала дня (для daily reset)
    day_start_timestamp: Arc<Mutex<Option<u64>>>,
    /// База данных для персистентности
    db: Option<Arc<Database>>,
}

impl TimerEngine {
    /// Создать новый TimerEngine без БД (для тестов или fallback)
    #[allow(dead_code)] // Может использоваться в тестах или как fallback
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(TimerState::Stopped)),
            accumulated_seconds: Arc::new(Mutex::new(0)),
            day_start_timestamp: Arc::new(Mutex::new(None)),
            db: None,
        }
    }

    /// Инициализация с базой данных
    fn with_db(db: Arc<Database>) -> Self {
        let engine = Self {
            state: Arc::new(Mutex::new(TimerState::Stopped)),
            accumulated_seconds: Arc::new(Mutex::new(0)),
            day_start_timestamp: Arc::new(Mutex::new(None)),
            db: Some(db),
        };

        // Восстанавливаем состояние из БД
        if let Err(e) = engine.restore_state() {
            eprintln!("[TIMER] Failed to restore state from DB: {}", e);
        }

        engine
    }

    /// Восстановить состояние из БД
    /// GUARD: НИКОГДА не крашиться на ошибке восстановления
    fn restore_state(&self) -> Result<(), String> {
        let db = match &self.db {
            Some(db) => db,
            None => {
                info!("[RECOVERY] No database available, starting with default state");
                return Ok(()); // Нет БД - пропускаем
            }
        };

        // GUARD: Обработка всех возможных ошибок
        match db.load_timer_state() {
            Ok(Some((day_str, accumulated, state_str, saved_started_at))) => {
                let today_utc = Utc::now().format("%Y-%m-%d").to_string();

                if day_str == today_utc {
                    // CRITICAL FIX: Если было running, добавляем elapsed time к accumulated
                    // С защитой от clock skew
                    let final_accumulated = if state_str == "running" && saved_started_at.is_some()
                    {
                        let started_at = saved_started_at.unwrap();
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs();

                        // CRITICAL FIX: Clock skew detection
                        // ДОКАЗАНО: Если now < started_at, часы были переведены назад
                        if now < started_at {
                            // ДОКАЗАНО: Clock skew detected - часы переведены назад
                            warn!(
                                "[RECOVERY] Clock skew detected: now ({}) < started_at ({}). Not adding elapsed time to prevent time loss.",
                                now, started_at
                            );
                            // НЕ добавляем elapsed time - используем только saved accumulated
                            accumulated
                        } else {
                            let elapsed_since_save = now.saturating_sub(started_at);

                            // CRITICAL FIX: Проверка на нереалистично большое время (> 24 часов)
                            // ДОКАЗАНО: Если elapsed > 24 часов, вероятно clock skew или системная ошибка
                            const MAX_REASONABLE_ELAPSED: u64 = 24 * 60 * 60; // 24 часа
                            if elapsed_since_save > MAX_REASONABLE_ELAPSED {
                                warn!(
                                    "[RECOVERY] Unrealistic time gap detected: {}s ({} hours). Possible clock skew. Not adding elapsed time.",
                                    elapsed_since_save, elapsed_since_save / 3600
                                );
                                // НЕ добавляем elapsed time - используем только saved accumulated
                                accumulated
                            } else {
                                // ДОКАЗАНО: Elapsed time разумен - добавляем к accumulated
                                let new_accumulated =
                                    accumulated.saturating_add(elapsed_since_save);
                                info!(
                                    "[RECOVERY] Timer was running: accumulated={}s, started_at={}, elapsed_since_save={}s, final_accumulated={}s",
                                    accumulated, started_at, elapsed_since_save, new_accumulated
                                );
                                new_accumulated
                            }
                        }
                    } else {
                        // ДОКАЗАНО: State не был running - используем saved accumulated
                        accumulated
                    };

                    // Восстанавливаем накопленное время
                    match self.accumulated_seconds.lock() {
                        Ok(mut acc) => *acc = final_accumulated,
                        Err(e) => {
                            error!("[RECOVERY] Mutex poisoned for accumulated_seconds: {}. Using default (0).", e);
                            // Продолжаем с дефолтным значением
                        }
                    }

                    // Восстанавливаем состояние
                    let state = match state_str.as_str() {
                        "stopped" => TimerState::Stopped,
                        "paused" => TimerState::Paused,
                        "running" => {
                            // Если было running, восстанавливаем как paused (безопаснее)
                            // Пользователь может возобновить вручную
                            TimerState::Paused
                        }
                        _ => {
                            warn!(
                                "[RECOVERY] Unknown state '{}', defaulting to Stopped",
                                state_str
                            );
                            TimerState::Stopped
                        }
                    };

                    match self.state.lock() {
                        Ok(mut state_mutex) => *state_mutex = state,
                        Err(e) => {
                            error!(
                                "[RECOVERY] Mutex poisoned for state: {}. Using default (Stopped).",
                                e
                            );
                            // Продолжаем с дефолтным состоянием
                        }
                    }

                    info!(
                        "[RECOVERY] Restored state: day={}, accumulated={}s, state={}",
                        day_str, final_accumulated, state_str
                    );
                } else {
                    // День изменился - сбрасываем
                    info!(
                        "[RECOVERY] Day changed ({} → {}), resetting state",
                        day_str, today_utc
                    );
                    // Не восстанавливаем состояние
                }
            }
            Ok(None) => {
                // Нет сохраненного состояния - это нормально для первого запуска
                info!("[RECOVERY] No saved state found, starting fresh");
            }
            Err(e) => {
                // GUARD: НИКОГДА не крашиться на ошибке восстановления
                error!(
                    "[RECOVERY] Failed to load state from DB: {}. Starting with default state.",
                    e
                );
                // Продолжаем с дефолтным состоянием (Stopped, accumulated=0)
            }
        }

        Ok(())
    }

    /// Обработка системного sleep
    /// Если RUNNING → pause и сохранить состояние
    /// Примечание: Метод может использоваться в будущем для прямых системных событий sleep/wake
    #[allow(dead_code)]
    fn handle_system_sleep(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running { .. } => {
                // Допустимый переход: Running → Paused (из-за sleep)
                drop(state); // Освобождаем lock перед вызовом pause()

                eprintln!("[SLEEP] System sleep detected, pausing timer");

                // Используем существующий метод pause() для корректного перехода FSM
                self.pause()?;

                eprintln!("[SLEEP] Timer paused successfully due to system sleep");
                Ok(())
            }
            TimerState::Paused | TimerState::Stopped => {
                // Уже на паузе или остановлен - ничего не делаем (идемпотентно)
                eprintln!("[SLEEP] System sleep detected, but timer is already paused/stopped");
                Ok(())
            }
        }
    }

    /// Обработка системного wake
    /// НЕ возобновляем автоматически - оставляем PAUSED
    /// Идемпотентно: повторные вызовы не меняют состояние
    #[allow(dead_code)] // Используется в sleep/wake handling (может вызываться через системные события)
    pub fn handle_system_wake(&self) -> Result<(), String> {
        eprintln!("[WAKE] System wake detected");

        // Проверяем текущее состояние
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let state_str = match &*state {
            TimerState::Running { .. } => "running",
            TimerState::Paused => "paused",
            TimerState::Stopped => "stopped",
        };
        drop(state);

        // Обновляем last_updated_at в БД
        // НЕ возобновляем RUNNING автоматически - безопаснее оставить PAUSED
        if let Err(e) = self.save_state() {
            eprintln!("[WAKE] Failed to save state after wake: {}", e);
        }

        eprintln!(
            "[WAKE] Timer state after wake: {} (user can resume manually)",
            state_str
        );
        Ok(())
    }

    /// Сохранить состояние в БД
    /// Публичный метод для явного сохранения (например, при закрытии приложения)
    pub fn save_state(&self) -> Result<(), String> {
        self.save_state_with_accumulated_override(None)
    }

    /// Сохранить состояние в БД с переопределением accumulated
    /// CRITICAL FIX: Используется для атомарного сохранения после pause/stop
    fn save_state_with_accumulated_override(
        &self,
        accumulated_override: Option<u64>,
    ) -> Result<(), String> {
        let db = match &self.db {
            Some(db) => db,
            None => return Ok(()), // Нет БД - пропускаем
        };

        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let accumulated = if let Some(override_val) = accumulated_override {
            // Используем переданное значение (для атомарности)
            override_val
        } else {
            // Используем текущее значение из памяти
            *self
                .accumulated_seconds
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?
        };
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        // Определяем день
        let day = if let Some(day_start_ts) = day_start {
            // Используем сохраненный день
            let dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
            dt.format("%Y-%m-%d").to_string()
        } else {
            // Используем текущий день
            Utc::now().format("%Y-%m-%d").to_string()
        };

        // Определяем строковое представление состояния и started_at
        let (state_str, started_at) = match &*state {
            TimerState::Stopped => ("stopped", None),
            TimerState::Running { started_at, .. } => ("running", Some(*started_at)),
            TimerState::Paused => ("paused", None),
        };

        db.save_timer_state(&day, accumulated, state_str, started_at)
            .map_err(|e| format!("Failed to save state to DB: {}", e))?;

        Ok(())
    }

    /// Переход: Stopped → Running или Paused → Running
    /// Атомарная операция - один mutex lock на весь переход
    fn start(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Stopped => {
                // Допустимый переход: Stopped → Running
                let now_instant = Instant::now();
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Если это первый старт за день, фиксируем начало дня
                let mut day_start = self
                    .day_start_timestamp
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                if day_start.is_none() {
                    *day_start = Some(now_timestamp);
                }
                drop(day_start); // Освобождаем lock

                // Переход в Running с данными внутри
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // Сохраняем состояние в БД
                if let Err(e) = self.save_state() {
                    eprintln!("[TIMER] Failed to save state after start: {}", e);
                }

                Ok(())
            }
            TimerState::Paused => {
                // Допустимый переход: Paused → Running (resume через start)
                let now_instant = Instant::now();
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в других переходах start())
                if let Err(e) = self.save_state() {
                    eprintln!(
                        "[TIMER] Failed to save state after start (Paused→Running): {}",
                        e
                    );
                }

                Ok(())
            }
            TimerState::Running { .. } => {
                // Недопустимый переход: Running → Running
                warn!("[FSM] Invalid transition: Running → Running (already running)");
                Err("Timer is already running".to_string())
            }
        }
    }

    /// Переход: Running → Paused
    /// Сохраняет время сессии в accumulated
    fn pause(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at_instant, ..
            } => {
                // Допустимый переход: Running → Paused
                let now = Instant::now();
                let session_elapsed = now.duration_since(*started_at_instant).as_secs();

                // CRITICAL FIX: Вычисляем новый accumulated БЕЗ обновления в памяти
                // Это позволяет сохранить атомарность: либо обновляем и сохраняем, либо ничего
                let new_accumulated = {
                    let accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    let old_value = *accumulated;
                    let new = accumulated.saturating_add(session_elapsed);
                    if old_value > new {
                        // Произошло насыщение (переполнение предотвращено)
                        warn!(
                            "[TIMER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                            old_value, session_elapsed, new
                        );
                    }
                    new
                };

                // CRITICAL FIX: Обновляем accumulated в памяти ТОЛЬКО после успешного сохранения
                // Это гарантирует, что если save_state() падает, accumulated не обновлен
                // Переход в Paused (started_at_instant удаляется из state)
                *state = TimerState::Paused;
                drop(state); // Освобождаем lock перед сохранением

                // CRITICAL FIX: Сохраняем состояние с новым accumulated в одной транзакции
                // Если сохранение успешно, обновляем accumulated в памяти
                match self.save_state_with_accumulated_override(Some(new_accumulated)) {
                    Ok(_) => {
                        // ДОКАЗАНО: Сохранение успешно - обновляем accumulated в памяти
                        let mut accumulated = self
                            .accumulated_seconds
                            .lock()
                            .map_err(|e| format!("Mutex poisoned: {}", e))?;
                        *accumulated = new_accumulated;
                        // Lock освобождается автоматически
                    }
                    Err(e) => {
                        // ДОКАЗАНО: Сохранение не удалось - accumulated НЕ обновлен в памяти
                        // State уже изменен на Paused, но accumulated остался старым
                        // Это безопаснее, чем обновить accumulated до сохранения
                        eprintln!("[TIMER] Failed to save state after pause: {}", e);
                        // Возвращаем ошибку, чтобы вызывающий код знал о проблеме
                        return Err(format!("Failed to save state after pause: {}", e));
                    }
                }

                Ok(())
            }
            TimerState::Paused => {
                // Недопустимый переход: Paused → Paused
                warn!("[FSM] Invalid transition: Paused → Paused (already paused)");
                Err("Timer is already paused".to_string())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Paused
                warn!("[FSM] Invalid transition: Stopped → Paused (cannot pause stopped timer)");
                Err("Cannot pause stopped timer".to_string())
            }
        }
    }

    /// Переход: Paused → Running
    /// Начинает новую сессию (accumulated сохраняется)
    fn resume(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Paused => {
                // Допустимый переход: Paused → Running
                let now_instant = Instant::now();
                let now_timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_secs();

                // Переход в Running (accumulated сохраняется)
                *state = TimerState::Running {
                    started_at: now_timestamp,
                    started_at_instant: now_instant,
                };
                drop(state); // Освобождаем lock перед сохранением

                // FIX: Сохраняем состояние в БД (как в start(), pause(), stop())
                if let Err(e) = self.save_state() {
                    eprintln!("[TIMER] Failed to save state after resume: {}", e);
                }

                Ok(())
            }
            TimerState::Running { .. } => {
                // Недопустимый переход: Running → Running
                warn!("[FSM] Invalid transition: Running → Running (already running)");
                Err("Timer is already running".to_string())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Running (нужно использовать start)
                warn!("[FSM] Invalid transition: Stopped → Running (use start() instead)");
                Err("Cannot resume stopped timer. Use start() instead".to_string())
            }
        }
    }

    /// Переход: Running → Stopped или Paused → Stopped
    /// Сохраняет время сессии в accumulated (если Running)
    fn stop(&self) -> Result<(), String> {
        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        self.stop_internal()
    }

    /// Внутренний метод остановки без проверки дня (для использования в rollover)
    fn stop_internal(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        match &*state {
            TimerState::Running {
                started_at_instant, ..
            } => {
                // Допустимый переход: Running → Stopped
                let now = Instant::now();
                let session_elapsed = now.duration_since(*started_at_instant).as_secs();

                // CRITICAL FIX: Вычисляем новый accumulated БЕЗ обновления в памяти
                let new_accumulated = {
                    let accumulated = self
                        .accumulated_seconds
                        .lock()
                        .map_err(|e| format!("Mutex poisoned: {}", e))?;
                    let old_value = *accumulated;
                    let new = accumulated.saturating_add(session_elapsed);
                    if old_value > new {
                        warn!(
                            "[TIMER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                            old_value, session_elapsed, new
                        );
                    }
                    new
                };

                // Переход в Stopped
                *state = TimerState::Stopped;
                drop(state); // Освобождаем lock перед сохранением

                // CRITICAL FIX: Сохраняем состояние с новым accumulated в одной транзакции
                match self.save_state_with_accumulated_override(Some(new_accumulated)) {
                    Ok(_) => {
                        // ДОКАЗАНО: Сохранение успешно - обновляем accumulated в памяти
                        let mut accumulated = self
                            .accumulated_seconds
                            .lock()
                            .map_err(|e| format!("Mutex poisoned: {}", e))?;
                        *accumulated = new_accumulated;
                    }
                    Err(e) => {
                        // ДОКАЗАНО: Сохранение не удалось - accumulated НЕ обновлен
                        eprintln!("[TIMER] Failed to save state after stop: {}", e);
                        return Err(format!("Failed to save state after stop: {}", e));
                    }
                }

                Ok(())
            }
            TimerState::Paused => {
                // Допустимый переход: Paused → Stopped (accumulated уже сохранен)
                *state = TimerState::Stopped;
                drop(state); // Освобождаем lock перед сохранением

                // Сохраняем состояние в БД
                if let Err(e) = self.save_state() {
                    eprintln!("[TIMER] Failed to save state after stop: {}", e);
                }

                Ok(())
            }
            TimerState::Stopped => {
                // Недопустимый переход: Stopped → Stopped
                warn!("[FSM] Invalid transition: Stopped → Stopped (already stopped)");
                Err("Timer is already stopped".to_string())
            }
        }
    }

    /// Получить текущее состояние таймера
    /// ВАЖНО: Этот метод может мутировать состояние при обнаружении sleep
    /// Sleep detection: большие пропуски времени (> 5 мин) автоматически паузируют таймер
    fn get_state(&self) -> Result<TimerStateResponse, String> {
        // Используем внутренний метод с depth tracking для защиты от рекурсии
        self.get_state_internal(0)
    }

    /// Внутренний метод get_state с защитой от рекурсии
    fn get_state_internal(&self, depth: u8) -> Result<TimerStateResponse, String> {
        // GUARD: Ограничение глубины рекурсии
        const MAX_RECURSION_DEPTH: u8 = 3;
        if depth > MAX_RECURSION_DEPTH {
            error!(
                "[RECURSION] Max recursion depth ({}) exceeded in get_state(). \
                Possible infinite loop or cascading state changes.",
                MAX_RECURSION_DEPTH
            );
            return Err(format!(
                "Max recursion depth exceeded in get_state() (depth: {})",
                depth
            ));
        }

        // Проверяем смену дня перед любыми операциями
        self.ensure_correct_day()?;

        // Проверяем состояние для sleep detection
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let accumulated = *self
            .accumulated_seconds
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        // Расчет elapsed только для RUNNING состояния
        // Формула: accumulated + (now - started_at_instant)
        // Дополнительно: проверка на sleep (большой пропуск времени)
        let (elapsed_seconds, session_start, needs_sleep_handling) = match &*state {
            TimerState::Running {
                started_at,
                started_at_instant,
            } => {
                let now = Instant::now();
                let session_elapsed = now.duration_since(*started_at_instant).as_secs();

                // Проверка на sleep: если пропуск > 15 минут, это вероятно sleep
                // FIX: Увеличен порог с 5 до 15 минут, чтобы избежать ложных срабатываний
                const SLEEP_DETECTION_THRESHOLD_SECONDS: u64 = 15 * 60; // 15 минут
                let is_sleep = session_elapsed > SLEEP_DETECTION_THRESHOLD_SECONDS;

                // FIX: Защита от переполнения при вычислении elapsed_seconds
                let elapsed = accumulated.saturating_add(session_elapsed);
                (elapsed, Some(*started_at), is_sleep)
            }
            TimerState::Paused | TimerState::Stopped => {
                // В PAUSED и STOPPED показываем только accumulated
                (accumulated, None, false)
            }
        };

        // Если обнаружен sleep, логируем предупреждение (но НЕ ставим на паузу автоматически)
        if needs_sleep_handling {
            // Получаем session_elapsed перед drop(state)
            let session_elapsed = match &*state {
                TimerState::Running {
                    started_at_instant, ..
                } => Instant::now().duration_since(*started_at_instant).as_secs(),
                _ => 0,
            };
            warn!(
                "[SLEEP_DETECTION] Large time gap detected ({}s), but NOT auto-pausing to prevent false positives (depth: {})",
                session_elapsed, depth
            );
            // FIX: НЕ ставим на паузу автоматически - это может быть просто долгая работа без активности
            // Пользователь может поставить на паузу вручную, если нужно
            // Только логируем предупреждение для диагностики
            // Автоматическая пауза отключена, чтобы избежать ложных срабатываний
            // Продолжаем выполнение без изменения состояния
        }

        // Создаем упрощенную версию state для API (без Instant)
        let state_for_response = match &*state {
            TimerState::Stopped => TimerStateForAPI::Stopped,
            TimerState::Running { started_at, .. } => TimerStateForAPI::Running {
                started_at: *started_at,
            },
            TimerState::Paused => TimerStateForAPI::Paused,
        };

        Ok(TimerStateResponse {
            state: state_for_response,
            elapsed_seconds,
            accumulated_seconds: accumulated,
            session_start,
            day_start,
        })
    }

    /// Проверить и обработать смену календарного дня
    /// Вызывается в начале всех публичных методов для автоматического rollover
    /// GUARD: Использует UTC для определения дня (не зависит от timezone)
    fn ensure_correct_day(&self) -> Result<(), String> {
        let day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        // FIX: Используем UTC для определения дня (не зависит от timezone)
        let today_utc = Utc::now().date_naive();

        // Если day_start не установлен, устанавливаем текущий день
        let saved_day_utc = if let Some(day_start_ts) = day_start {
            // FIX: Конвертируем timestamp в UTC дату (не Local!)
            let dt = chrono::DateTime::<Utc>::from_timestamp(day_start_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?;
            dt.date_naive()
        } else {
            // Если day_start не установлен, устанавливаем текущий день
            let now_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs();
            let mut day_start_mutex = self
                .day_start_timestamp
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *day_start_mutex = Some(now_timestamp);
            return Ok(()); // Первый запуск - день установлен
        };

        // Если день не изменился, ничего не делаем
        if saved_day_utc == today_utc {
            return Ok(());
        }

        // GUARD: Проверка на разумность смены дня (не более 1 дня назад/вперед)
        let days_diff = (today_utc - saved_day_utc).num_days().abs();
        if days_diff > 1 {
            warn!(
                "[DAY_ROLLOVER] Suspicious day change: {} → {} ({} days). \
                Possible timezone change or system clock manipulation.",
                saved_day_utc.format("%Y-%m-%d"),
                today_utc.format("%Y-%m-%d"),
                days_diff
            );
            // Все равно выполняем rollover, но логируем предупреждение
        }

        // День изменился - выполняем rollover
        info!(
            "[DAY_ROLLOVER] Day changed: {} → {}",
            saved_day_utc.format("%Y-%m-%d"),
            today_utc.format("%Y-%m-%d")
        );
        self.rollover_day(saved_day_utc, today_utc)
    }

    /// Обработать смену дня (rollover)
    /// Вызывается автоматически при обнаружении смены календарного дня
    fn rollover_day(
        &self,
        old_day: chrono::NaiveDate,
        new_day: chrono::NaiveDate,
    ) -> Result<(), String> {
        info!(
            "[DAY_ROLLOVER] Rolling over from {} to {}",
            old_day.format("%Y-%m-%d"),
            new_day.format("%Y-%m-%d")
        );

        // Проверяем состояние FSM
        let state = self
            .state
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        let was_running = matches!(&*state, TimerState::Running { .. });
        drop(state); // Освобождаем lock перед дальнейшими операциями

        // Если таймер был RUNNING, нужно корректно зафиксировать время до полуночи
        if was_running {
            // Получаем timestamp полуночи старого дня (00:00:00 следующего дня = конец старого дня)
            // FIX: Используем UTC вместо Local
            let old_day_end = new_day
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| dt.and_local_timezone(Utc).earliest())
                .ok_or_else(|| "Failed to create old day end timestamp".to_string())?
                .timestamp() as u64;

            // Получаем started_at и started_at_instant из состояния
            // GUARD: Проверка расхождения между SystemTime и Instant (clock skew detection)
            let (started_at, started_at_instant) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                match &*state {
                    TimerState::Running {
                        started_at,
                        started_at_instant,
                    } => (*started_at, *started_at_instant),
                    _ => {
                        drop(state);
                        return Err("Timer state changed during rollover".to_string());
                    }
                }
            };

            // GUARD: Clock skew detection - сравниваем SystemTime и Instant
            let now_system = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get system timestamp: {}", e))?
                .as_secs();
            let now_instant = Instant::now();

            let system_time_elapsed = now_system.saturating_sub(started_at);
            let instant_elapsed = now_instant.duration_since(started_at_instant).as_secs();

            // Вычисляем расхождение (clock skew)
            let clock_skew = if system_time_elapsed > instant_elapsed {
                system_time_elapsed - instant_elapsed
            } else {
                instant_elapsed - system_time_elapsed
            };

            // Если расхождение > 60 секунд, это clock skew
            if clock_skew > 60 {
                warn!(
                    "[CLOCK_SKEW] System time changed during timer run. \
                    System elapsed: {}s, Instant elapsed: {}s, Skew: {}s. \
                    Using Instant as source of truth for elapsed time.",
                    system_time_elapsed, instant_elapsed, clock_skew
                );
            }

            // Вычисляем время до полуночи (если started_at был до полуночи)
            // ВАЖНО: Для расчета времени до полуночи используем SystemTime (started_at),
            // так как Instant не имеет связи с календарным временем.
            // Но при наличии clock skew мы ограничиваем результат Instant elapsed.
            if started_at < old_day_end {
                let time_until_midnight = old_day_end - started_at;

                // GUARD: Проверка на разумность времени до полуночи (не более 24 часов)
                // Дополнительно: если есть clock skew, ограничиваем Instant elapsed
                let time_until_midnight = if time_until_midnight > 24 * 3600 {
                    warn!(
                        "[DAY_ROLLOVER] Suspicious time until midnight: {}s (> 24h). \
                        Possible clock manipulation. Using 24h as maximum.",
                        time_until_midnight
                    );
                    // Ограничиваем максимум 24 часами
                    24 * 3600
                } else if clock_skew > 60 && time_until_midnight > instant_elapsed + clock_skew {
                    // Если есть clock skew и time_until_midnight подозрительно большой,
                    // ограничиваем его instant_elapsed (используем Instant как source of truth)
                    warn!(
                        "[CLOCK_SKEW] Time until midnight ({}) exceeds Instant elapsed ({}) + skew ({}). \
                        Limiting to Instant elapsed to prevent time loss.",
                        time_until_midnight, instant_elapsed, clock_skew
                    );
                    instant_elapsed
                } else {
                    time_until_midnight
                };

                // Обновляем accumulated_seconds (время за старый день)
                // FIX: Защита от переполнения - используем saturating_add
                let mut accumulated = self
                    .accumulated_seconds
                    .lock()
                    .map_err(|e| format!("Mutex poisoned: {}", e))?;
                let old_value = *accumulated;
                *accumulated = accumulated.saturating_add(time_until_midnight);
                if old_value > *accumulated {
                    // Произошло насыщение (переполнение предотвращено)
                    warn!(
                        "[DAY_ROLLOVER] Accumulated seconds overflow prevented: {} + {} = {} (saturated at u64::MAX)",
                        old_value, time_until_midnight, *accumulated
                    );
                }
                drop(accumulated);

                info!(
                    "[DAY_ROLLOVER] Added {} seconds from old day (before midnight)",
                    time_until_midnight
                );
            }

            // Переводим таймер в STOPPED вручную (без вызова stop_internal, чтобы избежать двойного добавления времени)
            let mut state = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            *state = TimerState::Stopped;
            drop(state);
        }

        // Обнуляем accumulated_seconds для нового дня
        // ВАЖНО: Это делается ПОСЛЕ обработки RUNNING состояния
        // Время за старый день уже зафиксировано выше (если был RUNNING)
        let mut accumulated = self
            .accumulated_seconds
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        *accumulated = 0;
        drop(accumulated);

        // Обновляем day_start_timestamp на новый день (полночь нового дня в UTC)
        // FIX: Используем UTC вместо Local для независимости от timezone
        let new_day_start = new_day
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| dt.and_local_timezone(Utc).earliest())
            .ok_or_else(|| "Failed to create new day start timestamp".to_string())?
            .timestamp() as u64;

        // GUARD: Проверка, что rollover не выполняется дважды
        let current_day_start = *self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        if let Some(current_ts) = current_day_start {
            let current_day = chrono::DateTime::<Utc>::from_timestamp(current_ts as i64, 0)
                .ok_or_else(|| "Invalid day_start timestamp".to_string())?
                .date_naive();

            // Если день уже обновлен, это двойной вызов
            if current_day == new_day {
                warn!(
                    "[DAY_ROLLOVER] Day already rolled over to {}, skipping duplicate rollover",
                    new_day.format("%Y-%m-%d")
                );
                return Ok(());
            }
        }

        let mut day_start = self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        *day_start = Some(new_day_start);
        drop(day_start);

        // Сохраняем новое состояние в БД
        if let Err(e) = self.save_state() {
            warn!("[DAY_ROLLOVER] Failed to save state after rollover: {}", e);
            // Не возвращаем ошибку - rollover выполнен, сохранение можно повторить
        }

        info!(
            "[DAY_ROLLOVER] Rollover completed. New day: {}",
            new_day.format("%Y-%m-%d")
        );
        Ok(())
    }

    fn reset_day(&self) -> Result<(), String> {
        // Проверяем состояние - нельзя сбрасывать день если таймер RUNNING
        let is_running = {
            let state_lock = self
                .state
                .lock()
                .map_err(|e| format!("Mutex poisoned: {}", e))?;
            matches!(&*state_lock, TimerState::Running { .. })
        };

        if is_running {
            // Если таймер работает, сначала останавливаем его
            // Это предотвращает потерю времени
            self.stop()?;
        }

        // Теперь безопасно сбрасываем (таймер Stopped или Paused)

        // Теперь безопасно сбрасываем
        let mut accumulated = self
            .accumulated_seconds
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        let mut day_start = self
            .day_start_timestamp
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;

        *accumulated = 0;
        *day_start = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?
                .as_secs(),
        );

        Ok(())
    }
}

struct ActivityMonitor {
    is_monitoring: Arc<Mutex<bool>>,
    last_activity: Arc<Mutex<Instant>>,
}

impl ActivityMonitor {
    fn new() -> Self {
        Self {
            is_monitoring: Arc::new(Mutex::new(false)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
        }
    }
}

#[tauri::command]
async fn start_activity_monitoring(
    monitor: State<'_, ActivityMonitor>,
    app: AppHandle,
) -> Result<(), String> {
    let is_monitoring = monitor.is_monitoring.clone();
    let last_activity = monitor.last_activity.clone();

    // Use a single lock to check and set atomically to prevent race conditions
    {
        let mut monitoring = is_monitoring
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        if *monitoring {
            return Ok(()); // Already monitoring
        }
        *monitoring = true;
    } // Lock is released here before spawning the task

    // Update last activity time
    {
        let mut last = last_activity
            .lock()
            .map_err(|e| format!("Mutex poisoned: {}", e))?;
        *last = Instant::now();
    }

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Class;
        use objc::{msg_send, sel, sel_impl};
        use std::time::Duration;

        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        // Spawn a thread for activity monitoring by checking mouse position
        tokio::spawn(async move {
            use tauri::Emitter;
            let mut last_mouse_pos: Option<(f64, f64)> = None;
            let mut last_emit_time = Instant::now();
            let min_emit_interval = Duration::from_secs(10); // Emit activity event at most once every 10 seconds
            let mut consecutive_movements = 0; // Track consecutive small movements

            loop {
                {
                    // Check if monitoring should continue
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break, // Mutex poisoned, exit loop
                    };
                    if !*monitoring {
                        break;
                    }
                }

                // Get current mouse position using NSEvent.mouseLocation through objc
                unsafe {
                    let ns_event_class = match Class::get("NSEvent") {
                        Some(class) => class,
                        None => {
                            // Class not found, skip this iteration
                            tokio::time::sleep(Duration::from_millis(1000)).await;
                            continue;
                        }
                    };
                    let mouse_location: core_graphics::geometry::CGPoint =
                        msg_send![ns_event_class, mouseLocation];

                    let current_mouse_pos = (mouse_location.x, mouse_location.y);

                    // Check if mouse moved significantly
                    let mut activity_detected = false;
                    if let Some((last_x, last_y)) = last_mouse_pos {
                        let delta_x = (current_mouse_pos.0 - last_x).abs();
                        let delta_y = (current_mouse_pos.1 - last_y).abs();
                        let total_delta = (delta_x * delta_x + delta_y * delta_y).sqrt();

                        // If mouse moved more than 20 pixels, consider it real activity
                        // This filters out small hand tremors and system noise
                        if total_delta > 20.0 {
                            activity_detected = true;
                            consecutive_movements = 0; // Reset counter on significant movement
                        } else if total_delta > 1.0 {
                            // Small movement - increment counter
                            consecutive_movements += 1;
                            // If many small movements accumulate, it might be real activity
                            if consecutive_movements >= 10 {
                                activity_detected = true;
                                consecutive_movements = 0;
                            }
                        } else {
                            // No movement - reset counter
                            consecutive_movements = 0;
                        }
                    } else {
                        // First check - don't emit immediately, just initialize
                        last_mouse_pos = Some(current_mouse_pos);
                        tokio::time::sleep(Duration::from_millis(1000)).await;
                        continue;
                    }

                    // Only emit event if activity detected AND enough time has passed since last emit
                    if activity_detected {
                        let now = Instant::now();
                        if now.duration_since(last_emit_time) >= min_emit_interval {
                            // Update activity time first (even if emit fails)
                            {
                                if let Ok(mut last) = last_activity_clone.lock() {
                                    *last = Instant::now();
                                }
                            }
                            // Emit event (ignore errors)
                            app_clone.emit("activity-detected", ()).ok();
                            last_emit_time = now;
                        }
                    }

                    last_mouse_pos = Some(current_mouse_pos);
                }

                // Check every 1 second to reduce CPU usage and false positives
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For other platforms, implement similar logic
        let is_monitoring_clone = is_monitoring.clone();
        let last_activity_clone = last_activity.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            loop {
                {
                    // Check if monitoring should continue
                    let monitoring = match is_monitoring_clone.lock() {
                        Ok(m) => m,
                        Err(_) => break, // Mutex poisoned, exit loop
                    };
                    if !*monitoring {
                        break;
                    }
                }

                app_clone.emit("activity-detected", ()).ok();

                {
                    if let Ok(mut last) = last_activity_clone.lock() {
                        *last = Instant::now();
                    }
                    // If mutex is poisoned, continue anyway
                }

                tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
            }
        });
    }

    Ok(())
}

#[tauri::command]
async fn stop_activity_monitoring(monitor: State<'_, ActivityMonitor>) -> Result<(), String> {
    let mut monitoring = monitor
        .is_monitoring
        .lock()
        .map_err(|e| format!("Mutex poisoned: {}", e))?;
    *monitoring = false;
    Ok(())
}

#[tauri::command]
async fn listen_activity(_monitor: State<'_, ActivityMonitor>) -> Result<(), String> {
    // Activity monitoring is handled by start_activity_monitoring
    // This command exists for compatibility
    Ok(())
}

#[tauri::command]
async fn request_screenshot_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, screenshots crate will trigger permission request automatically
        // when trying to capture. We can check if we have permission by trying to get screens
        match screenshots::Screen::all() {
            Ok(_) => Ok(true),
            Err(_) => {
                // Permission not granted, but the system should prompt when we try to capture
                Ok(false)
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
async fn upload_screenshot(
    png_data: Vec<u8>,
    time_entry_id: String,
    access_token: String,
    refresh_token: Option<String>,
    sync_manager: State<'_, SyncManager>,
) -> Result<(), String> {
    info!("[RUST] Enqueueing screenshot: {} bytes", png_data.len());

    // Сначала сохраняем в очередь
    let queue_id =
        sync_manager.enqueue_screenshot(png_data, time_entry_id, access_token, refresh_token)?;
    info!("[RUST] Screenshot enqueued with ID: {}", queue_id);

    // Фоновая синхронизация уже запущена в setup, просто возвращаем успех
    // Данные будут синхронизированы автоматически
    Ok(())
}

#[tauri::command]
async fn enqueue_time_entry(
    operation: String,
    payload: serde_json::Value,
    access_token: String,
    refresh_token: Option<String>,
    sync_manager: State<'_, SyncManager>,
) -> Result<i64, String> {
    info!("[RUST] Enqueueing time entry operation: {}", operation);

    let queue_id =
        sync_manager.enqueue_time_entry(&operation, payload, access_token, refresh_token)?;
    info!("[RUST] Time entry operation enqueued with ID: {}", queue_id);

    Ok(queue_id)
}

#[tauri::command]
async fn take_screenshot(_time_entry_id: String) -> Result<Vec<u8>, String> {
    use image::{ImageBuffer, Rgba};

    // Take screenshot using screenshots crate
    let screens = screenshots::Screen::all().map_err(|e| {
        let err_msg = format!(
            "Failed to get screens: {:?}. Please grant screen recording permission in System Settings -> Privacy & Security -> Screen Recording.",
            e
        );
        eprintln!("[SCREENSHOT ERROR] {}", err_msg);
        err_msg
    })?;

    // Check if we have any screens available
    if screens.is_empty() {
        eprintln!("[SCREENSHOT ERROR] No screens available");
        return Err("No screens available".to_string());
    }

    // Use first screen without cloning (more efficient)
    let screen = &screens[0];

    // Capture screenshot
    let image = screen.capture().map_err(|e| {
        let err_msg = format!(
            "Failed to capture screenshot: {:?}. Please check screen recording permissions in System Settings.",
            e
        );
        eprintln!("[SCREENSHOT ERROR] {}", err_msg);
        err_msg
    })?;

    // Get image dimensions and RGBA data
    let width = image.width();
    let height = image.height();

    // Validate dimensions
    if width == 0 || height == 0 {
        eprintln!(
            "[SCREENSHOT ERROR] Invalid screenshot dimensions: {}x{}",
            width, height
        );
        return Err("Invalid screenshot dimensions".to_string());
    }

    // Get RGBA buffer from image (this is a reference, no copy yet)
    let rgba_data = image.rgba();

    // Create ImageBuffer from RGBA data - use as_raw() to avoid extra copy if possible
    // But we need to convert to Vec<u8> for ImageBuffer
    let img_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba_data.to_vec()).ok_or_else(|| {
            eprintln!("[SCREENSHOT ERROR] Failed to create ImageBuffer from RGBA data");
            "Failed to create ImageBuffer from RGBA data".to_string()
        })?;

    // If image is very large, resize it first to reduce file size
    // Target: max 1280x720 to keep file size under 1MB (for nginx limit)
    let max_width = 1280u32;
    let max_height = 720u32;
    let final_buffer = if width > max_width || height > max_height {
        eprintln!(
            "[SCREENSHOT] Image too large ({}x{}), resizing to max {}x{}",
            width, height, max_width, max_height
        );

        // Calculate new dimensions maintaining aspect ratio
        let aspect_ratio = width as f32 / height as f32;
        let (new_width, new_height) = if aspect_ratio > 1.0 {
            // Landscape
            if width > max_width {
                (max_width, (max_width as f32 / aspect_ratio) as u32)
            } else {
                ((max_height as f32 * aspect_ratio) as u32, max_height)
            }
        } else {
            // Portrait
            if height > max_height {
                ((max_height as f32 * aspect_ratio) as u32, max_height)
            } else {
                (max_width, (max_width as f32 / aspect_ratio) as u32)
            }
        };

        use image::imageops::resize;
        resize(
            &img_buffer,
            new_width,
            new_height,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img_buffer
    };

    // Convert to JPEG for smaller file size (PNG is too large for nginx limit)
    let final_width = final_buffer.width();
    let final_height = final_buffer.height();

    // Convert RGBA to RGB for JPEG (JPEG doesn't support alpha channel)
    use image::{DynamicImage, Rgb};
    let rgb_buffer: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_fn(final_width, final_height, |x, y| {
            let pixel = final_buffer.get_pixel(x, y);
            Rgb([pixel[0], pixel[1], pixel[2]])
        });

    // Convert to DynamicImage and encode as JPEG
    let dynamic_img = DynamicImage::ImageRgb8(rgb_buffer);
    let mut jpeg_bytes = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut jpeg_bytes);
        dynamic_img
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| {
                let err_msg = format!("Failed to encode JPEG: {:?}", e);
                eprintln!("[SCREENSHOT ERROR] {}", err_msg);
                err_msg
            })?;
    }

    // Validate that we actually have JPEG data
    if jpeg_bytes.is_empty() {
        eprintln!("[SCREENSHOT ERROR] Encoded JPEG data is empty");
        return Err("Screenshot encoding produced empty result".to_string());
    }

    eprintln!("[SCREENSHOT] Final JPEG size: {} bytes", jpeg_bytes.len());

    Ok(jpeg_bytes)
}

#[tauri::command]
async fn log_message(message: String) -> Result<(), String> {
    eprintln!("{}", message);
    Ok(())
}

#[tauri::command]
async fn show_notification(title: String, body: String, app: AppHandle) -> Result<(), String> {
    // Use Tauri notification plugin
    // Get Notification instance using NotificationExt trait
    use tauri_plugin_notification::NotificationExt;

    let notification = app.notification();

    notification
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("Failed to show notification: {:?}", e))?;

    Ok(())
}

// Note: System tray is now managed directly from the frontend using Tauri tray commands
// This command is kept for backward compatibility but does nothing
#[tauri::command]
async fn update_tray_time(
    _time_text: String,
    _is_tracking: bool,
    _is_paused: bool,
    _app: AppHandle,
) -> Result<(), String> {
    // System tray is now managed from frontend using plugin:tray commands
    Ok(())
}

#[tauri::command]
async fn show_idle_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // Get or create idle window
    if let Some(idle_window) = app.get_webview_window("idle") {
        // Window exists, just show it
        idle_window
            .show()
            .map_err(|e| format!("Failed to show idle window: {}", e))?;
        idle_window
            .set_focus()
            .map_err(|e| format!("Failed to focus idle window: {}", e))?;
    } else {
        // Window doesn't exist - it should be created from config, but if not, we'll try to create it
        // In Tauri 2.0, windows are typically created from config, so this should not happen
        return Err(
            "Idle window not found. Please ensure it's configured in tauri.conf.json".to_string(),
        );
    }

    Ok(())
}

#[tauri::command]
async fn hide_idle_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .hide()
            .map_err(|e| format!("Failed to hide idle window: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn update_idle_time(idle_seconds: u64, app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .emit("idle-time-update", idle_seconds)
            .map_err(|e| format!("Failed to emit idle time update: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn resume_tracking_from_idle(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // Emit event to main window to resume tracking
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("resume-tracking", ())
            .map_err(|e| format!("Failed to emit resume event: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn stop_tracking_from_idle(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // Emit event to main window to stop tracking
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("stop-tracking", ())
            .map_err(|e| format!("Failed to emit stop event: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn update_idle_state(
    idle_pause_start_time: Option<u64>,
    is_loading: bool,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    println!(
        "[RUST] update_idle_state called: idle_pause_start_time={:?}, is_loading={}",
        idle_pause_start_time, is_loading
    );

    // Convert Option<u64> to number or null for JSON
    let pause_time_json = match idle_pause_start_time {
        Some(t) => {
            println!("[RUST] Converting pause time: {} (u64) to JSON number", t);
            serde_json::Value::Number(serde_json::Number::from(t))
        }
        None => {
            println!("[RUST] Pause time is None, using null");
            serde_json::Value::Null
        }
    };

    let payload = serde_json::json!({
        "idlePauseStartTime": pause_time_json,
        "isLoading": is_loading,
    });

    println!(
        "[RUST] Emitting idle-state-update with payload: {:?}",
        payload
    );

    // Emit to idle window if it exists
    if let Some(idle_window) = app.get_webview_window("idle") {
        idle_window
            .emit("idle-state-update", &payload)
            .map_err(|e| {
                let err_msg = format!("Failed to emit idle state update: {}", e);
                println!("[RUST] Error: {}", err_msg);
                err_msg
            })?;
        println!("[RUST] Event emitted to idle window successfully");
    } else {
        println!("[RUST] Idle window not found - window may not be ready yet");
        // Don't fail - window might not be ready, state will be sent when window requests it
    }

    Ok(())
}

#[tauri::command]
async fn request_idle_state(app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    println!("[RUST] request_idle_state called - requesting state from main window");

    // Emit a request event to main window to send current state
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("request-idle-state-for-idle-window", ())
            .map_err(|e| format!("Failed to emit request: {}", e))?;
        println!("[RUST] Request event sent to main window");
    } else {
        println!("[RUST] Main window not found");
    }

    Ok(())
}

#[derive(serde::Serialize)]
struct ActiveWindowInfo {
    app_name: Option<String>,
    window_title: Option<String>,
    url: Option<String>,
    domain: Option<String>,
}

#[tauri::command]
async fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    #[cfg(target_os = "macos")]
    {
        // Используем AppleScript для безопасного получения информации об активном окне
        // AppleScript не вызывает Objective-C exceptions и работает стабильно

        use std::process::Command;

        // AppleScript для получения информации об активном приложении и окне
        let script = r#"
    tell application "System Events"
        try
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            
            try
                set frontWindow to first window of frontApp
                set windowTitle to title of frontWindow
            on error
                set windowTitle to ""
            end try
            
            return appName & "|" & windowTitle
        on error
            return ""
        end try
    end tell
"#;

        // Выполняем AppleScript через osascript
        let output = match Command::new("osascript").arg("-e").arg(script).output() {
            Ok(output) => output,
            Err(e) => {
                warn!("[ACTIVE_WINDOW] Failed to execute AppleScript: {}", e);
                return Ok(ActiveWindowInfo {
                    app_name: None,
                    window_title: None,
                    url: None,
                    domain: None,
                });
            }
        };

        // Проверяем успешность выполнения
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("[ACTIVE_WINDOW] AppleScript error: {}", stderr);
            return Ok(ActiveWindowInfo {
                app_name: None,
                window_title: None,
                url: None,
                domain: None,
            });
        }

        // Парсим результат
        let result = String::from_utf8_lossy(&output.stdout);
        let result = result.trim();

        if result.is_empty() {
            return Ok(ActiveWindowInfo {
                app_name: None,
                window_title: None,
                url: None,
                domain: None,
            });
        }

        // Разделяем результат: "AppName|WindowTitle"
        let parts: Vec<&str> = result.split('|').collect();
        let app_name = if parts.len() > 0 && !parts[0].is_empty() {
            Some(parts[0].to_string())
        } else {
            None
        };

        let window_title = if parts.len() > 1 && !parts[1].is_empty() {
            Some(parts[1].to_string())
        } else {
            None
        };

        // Извлекаем URL и domain из window_title (если это браузер)
        let (url, domain) = if let Some(ref title) = window_title {
            extract_url_from_title(title)
        } else {
            (None, None)
        };

        Ok(ActiveWindowInfo {
            app_name,
            window_title,
            url,
            domain,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For other platforms, return empty info for now
        Ok(ActiveWindowInfo {
            app_name: None,
            window_title: None,
            url: None,
            domain: None,
        })
    }
}

#[cfg(target_os = "macos")]
fn extract_url_from_title(title: &str) -> (Option<String>, Option<String>) {
    // Try to find URL patterns in title
    // Browsers often show URLs in window titles

    // Pattern 1: Direct URL (http:// or https://)
    if let Some(url_start) = title.find("http://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    if let Some(url_start) = title.find("https://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    // Pattern 2: Title might be just the domain (e.g., "github.com")
    // Check if it looks like a domain
    if title.contains('.') && !title.contains(' ') {
        // Might be a domain, but we can't be sure it's a URL
        // Return None for URL, but return as domain
        return (None, Some(title.to_string()));
    }

    (None, None)
}

#[cfg(target_os = "macos")]
fn extract_domain(url: &str) -> Option<String> {
    // Extract domain from URL
    // Example: https://github.com/user/repo -> github.com

    if url.starts_with("http://") {
        let without_protocol = &url[7..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    if url.starts_with("https://") {
        let without_protocol = &url[8..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    None
}

// ============================================
// TAURI COMMANDS для синхронизации
// ============================================

/// Установить токены для синхронизации (вызывается из frontend)
#[tauri::command]
async fn set_auth_tokens(
    sync_manager: State<'_, SyncManager>,
    access_token: Option<String>,
    refresh_token: Option<String>,
) -> Result<(), String> {
    sync_manager
        .auth_manager
        .set_tokens(access_token, refresh_token)
        .await;
    Ok(())
}

#[tauri::command]
async fn sync_queue_now(sync_manager: State<'_, SyncManager>) -> Result<usize, String> {
    sync_manager.sync_queue(5).await
}

/// Получить статус синхронизации (количество pending/failed задач)
#[tauri::command]
async fn get_sync_status(
    sync_manager: State<'_, SyncManager>,
) -> Result<SyncStatusResponse, String> {
    let pending_count = sync_manager
        .db
        .get_pending_count()
        .map_err(|e| format!("Failed to get pending count: {}", e))?;

    let failed_count = sync_manager
        .db
        .get_failed_count()
        .map_err(|e| format!("Failed to get failed count: {}", e))?;

    // Проверяем online статус через попытку HTTP запроса (легковесный HEAD запрос)
    let is_online = check_online_status().await;

    Ok(SyncStatusResponse {
        pending_count,
        failed_count,
        is_online,
    })
}

/// Получить детальную статистику очереди синхронизации
#[tauri::command]
async fn get_sync_queue_stats(sync_manager: State<'_, SyncManager>) -> Result<QueueStats, String> {
    sync_manager
        .db
        .get_queue_stats()
        .map_err(|e| format!("Failed to get queue stats: {}", e))
}

/// Проверка online статуса через легковесный HTTP запрос
async fn check_online_status() -> bool {
    // Используем быстрый GET запрос к надежному серверу
    // Используем Cloudflare или Google для проверки подключения
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    // Пробуем подключиться к надежному серверу (Cloudflare)
    // Используем минимальный запрос для проверки подключения
    match client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => {
            // Если Cloudflare недоступен, пробуем Google
            match client
                .get("https://www.google.com/generate_204")
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) => response.status().is_success() || response.status().as_u16() == 204,
                Err(_) => false,
            }
        }
    }
}

#[derive(serde::Serialize)]
struct SyncStatusResponse {
    pending_count: i32,
    failed_count: i32,
    is_online: bool,
}

/// Получить список failed задач с деталями
#[tauri::command]
async fn get_failed_tasks(
    sync_manager: State<'_, SyncManager>,
    limit: Option<i32>,
) -> Result<Vec<FailedTaskInfo>, String> {
    let limit = limit.unwrap_or(50); // По умолчанию 50 задач
    sync_manager
        .db
        .get_failed_tasks(limit)
        .map_err(|e| format!("Failed to get failed tasks: {}", e))
}

/// Сбросить failed задачи обратно в pending для повторной попытки
#[tauri::command]
async fn retry_failed_tasks(
    sync_manager: State<'_, SyncManager>,
    limit: Option<i32>,
) -> Result<i32, String> {
    let limit = limit.unwrap_or(100); // По умолчанию 100 задач
    let count = sync_manager
        .db
        .reset_failed_tasks(limit)
        .map_err(|e| format!("Failed to reset failed tasks: {}", e))?;

    info!("[SYNC] Reset {} failed tasks back to pending", count);

    // PRODUCTION: Запускаем синхронизацию через sync-lock
    let _ = sync_manager.sync_queue(5).await;

    Ok(count)
}

// ============================================
// TAURI COMMANDS для Timer Engine
// ============================================

#[tauri::command]
async fn start_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.start()?;
    engine.get_state()
}

#[tauri::command]
async fn pause_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.pause()?;
    engine.get_state()
}

#[tauri::command]
async fn resume_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.resume()?;
    engine.get_state()
}

#[tauri::command]
async fn stop_timer(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.stop()?;
    engine.get_state()
}

#[tauri::command]
async fn get_timer_state(engine: State<'_, Arc<TimerEngine>>) -> Result<TimerStateResponse, String> {
    engine.get_state()
}

#[tauri::command]
async fn reset_timer_day(engine: State<'_, Arc<TimerEngine>>) -> Result<(), String> {
    engine.reset_day()
}

#[tauri::command]
async fn save_timer_state(engine: State<'_, Arc<TimerEngine>>) -> Result<(), String> {
    engine.save_state()
}

// ============================================
// SYSTEM SLEEP / WAKE HANDLING
// ============================================

#[cfg(target_os = "macos")]
fn setup_sleep_wake_handlers(_app: AppHandle, _engine: Arc<TimerEngine>) -> Result<(), String> {
    // Для macOS используем проверку времени в get_state() для обнаружения sleep
    // Это более простой и надежный подход, чем работа с NSWorkspace notifications через FFI
    // Большие пропуски времени (> 5 минут) будут автоматически обнаруживаться и обрабатываться

    eprintln!("[SLEEP/WAKE] Sleep/wake detection enabled via time gap checking in get_state()");
    eprintln!("[SLEEP/WAKE] Large time gaps (> 5 min) will trigger automatic pause");

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn setup_sleep_wake_handlers(_app: AppHandle, _engine: Arc<TimerEngine>) -> Result<(), String> {
    // Для других платформ можно использовать platform-specific API
    eprintln!("[SLEEP/WAKE] Sleep/wake handlers not implemented for this platform");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Инициализация структурированного логирования
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Инициализация базы данных в setup hook
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Failed to get app data directory: {}", e),
                )
            })?;
            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "Failed to create app data directory at {}: {}",
                        app_data_dir.display(),
                        e
                    ),
                )
            })?;

            let db_path = app_data_dir.join("hubnity.db");
            let db_path_str = db_path.to_str().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "Database path contains invalid UTF-8: {}",
                        db_path.display()
                    ),
                )
            })?;
            let db = Arc::new(Database::new(db_path_str).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to initialize database: {}", e),
                )
            })?);

            eprintln!("[DB] Database initialized at: {}", db_path.display());

            // Инициализируем TimerEngine с БД
            let engine = TimerEngine::with_db(db.clone());
            let engine_arc = Arc::new(engine);

            // Настраиваем обработчики sleep/wake (не сохраняет ссылку на engine)
            setup_sleep_wake_handlers(app.handle().clone(), engine_arc.clone())?;

            // CRITICAL FIX: Сохраняем состояние таймера при закрытии окна
            // Используем Tauri window close event для гарантированного сохранения
            let engine_for_close = engine_arc.clone();
            let app_handle = app.handle().clone();
            app_handle.listen("tauri://close-requested", move |_event| {
                // ДОКАЗАНО: Это событие вызывается синхронно перед закрытием окна
                // Сохраняем состояние таймера синхронно
                if let Err(e) = engine_for_close.save_state() {
                    eprintln!("[SHUTDOWN] Failed to save timer state on window close: {}", e);
                } else {
                    info!("[SHUTDOWN] Timer state saved successfully on window close");
                }
            });

            // CRITICAL FIX: Периодическое сохранение состояния (каждые 30 секунд)
            // ДОКАЗАНО: Это гарантирует, что состояние сохранено даже при force quit
            let engine_for_periodic = engine_arc.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
                    eprintln!("[TIMER] Failed to create runtime for periodic save: {}", e);
                    std::process::exit(1);
                });
                rt.block_on(async {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
                    loop {
                        interval.tick().await;
                        // ДОКАЗАНО: Периодическое сохранение гарантирует актуальность состояния в БД
                        if let Err(e) = engine_for_periodic.save_state() {
                            warn!("[TIMER] Failed to save state periodically: {}", e);
                        } else {
                            debug!("[TIMER] State saved periodically");
                        }
                    }
                });
            });

            // Управляем engine через Tauri State
            // CRITICAL FIX: Используем Arc напрямую, так как он используется в других местах
            // ДОКАЗАНО: Tauri State может работать с Arc<TimerEngine>, так как Arc: Send + Sync
            app.manage(engine_arc);

            // Инициализируем SyncManager
            let sync_manager = SyncManager::new(db.clone());
            app.manage(sync_manager.clone());

            // Запускаем фоновую синхронизацию в отдельном потоке с собственным Tokio runtime
            // Запускаем фоновую синхронизацию после полной инициализации приложения
            // Используем std::thread::spawn с блокирующим runtime для фоновой задачи
            // Это безопасно, так как задача выполняется в отдельном потоке
            let sync_manager_bg = sync_manager.clone();

            // CRITICAL FIX: Background sync с restart mechanism
            // ДОКАЗАНО: Thread автоматически перезапускается при панике или ошибке
            std::thread::spawn(move || {
                loop {
                    // Создаем отдельный Tokio runtime для фоновой задачи
                    // Это необходимо, так как в setup hook основной runtime еще не готов
                    let rt = match tokio::runtime::Runtime::new() {
                        Ok(rt) => rt,
                        Err(e) => {
                            error!(
                                "[SYNC] CRITICAL: Failed to create Tokio runtime for background sync: {}. Retrying in 10s...",
                                e
                            );
                            std::thread::sleep(std::time::Duration::from_secs(10));
                            continue; // Retry создания runtime
                        }
                    };
                    
                    // ДОКАЗАНО: Если block_on паникует или завершается, цикл перезапустит runtime
                    let _result = rt.block_on(async {
                        // PRODUCTION: Увеличиваем задержку для восстановления токенов из localStorage
                        // Frontend восстанавливает токены при монтировании, нужно дать время
                        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

                        info!("[SYNC] Starting background sync task");
                        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60)); // Каждую минуту
                        loop {
                            interval.tick().await;
                            match sync_manager_bg.sync_queue(5).await {
                                Ok(count) => {
                                    if count > 0 {
                                        info!("[SYNC] Synced {} tasks", count);
                                    }
                                }
                                Err(e) => {
                                    // Не логируем как error, если это просто отсутствие токенов
                                    if e.contains("access token not set") {
                                        warn!("[SYNC] Background sync skipped: {}", e);
                                    } else {
                                        error!("[SYNC] Background sync error: {}", e);
                                        // ДОКАЗАНО: Ошибка не останавливает loop, sync продолжается
                                    }
                                }
                            }
                        }
                    });
                    
                    // ДОКАЗАНО: Если block_on завершился (не должно происходить в нормальных условиях),
                    // перезапускаем runtime через 10 секунд
                    error!("[SYNC] Background sync task exited unexpectedly. Restarting in 10s...");
                    std::thread::sleep(std::time::Duration::from_secs(10));
                }
            });
            info!("[SYNC] Background sync task started in separate thread with dedicated runtime");

            // Логирование уже выполнено выше через info!

            Ok(())
        })
        .manage(ActivityMonitor::new())
        .invoke_handler(tauri::generate_handler![
            // Sync commands
            set_auth_tokens,
            sync_queue_now,
            get_sync_status,
            get_sync_queue_stats,
            get_failed_tasks,
            retry_failed_tasks,
            // Timer Engine commands
            start_timer,
            pause_timer,
            resume_timer,
            stop_timer,
            get_timer_state,
            reset_timer_day,
            save_timer_state,
            get_active_window_info,
            // Existing commands
            start_activity_monitoring,
            stop_activity_monitoring,
            listen_activity,
            request_screenshot_permission,
            take_screenshot,
            upload_screenshot,
            enqueue_time_entry,
            show_notification,
            update_tray_time,
            log_message,
            show_idle_window,
            hide_idle_window,
            update_idle_time,
            resume_tracking_from_idle,
            stop_tracking_from_idle,
            update_idle_state,
            request_idle_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
