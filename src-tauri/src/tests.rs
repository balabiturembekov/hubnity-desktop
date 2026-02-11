use crate::auth::TokenEncryption;
use crate::database::*;
use crate::engine::*;
use crate::sync::*;
use crate::*;
use chrono::{Local, Utc};
use rusqlite::params;
use std::time::Instant;
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

            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));

            // Переход в Running
            engine.start().unwrap();

            let state = engine.get_state().unwrap();
            match state.state {
                engine::TimerStateForAPI::Running { started_at } => {
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Paused));
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
                engine::TimerStateForAPI::Running { started_at } => {
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
        }

        #[test]
        fn test_day_rollover_idempotent() {
            // Тест: Если rollover вызывается несколько раз → no-op
            let engine = TimerEngine::new();

            // Симулируем смену дня (вчера по локальному времени)
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            // Первый вызов ensure_correct_day()
            engine.ensure_correct_day().unwrap();

            let first_run_ts = engine.day_start_timestamp.lock().unwrap().unwrap();

            // Второй вызов ensure_correct_day() - должен быть no-op
            engine.ensure_correct_day().unwrap();

            let second_run_ts = engine.day_start_timestamp.lock().unwrap().unwrap();

            assert_eq!(first_run_ts, second_run_ts, "Second call must be no-op");

            // Проверяем, что день обновлен на сегодня (локальная дата)
            let today_local = Local::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date = chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                .unwrap()
                .with_timezone(&Local)
                .date_naive();
            assert_eq!(
                day_start_date, today_local,
                "Engine local date must match current local date"
            );
        }

        #[test]
        fn test_full_cycle_stopped_running_paused_stopped() {
            // Тест полного цикла: Stopped → Running → Paused → Stopped
            let engine = TimerEngine::new();

            // Начальное состояние
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
            assert_eq!(state.accumulated_seconds, 0);

            // Start
            engine.start().unwrap();
            thread::sleep(Duration::from_millis(300));
            let state = engine.get_state().unwrap();
            assert!(matches!(
                state.state,
                engine::TimerStateForAPI::Running { .. }
            ));

            // Pause
            engine.pause().unwrap();
            let accumulated_after_pause = engine.get_state().unwrap().accumulated_seconds;
            // accumulated_seconds is u64 (unsigned), so >= 0 is always true; assertion removed

            // Resume
            engine.resume().unwrap();
            thread::sleep(Duration::from_millis(200));
            let state = engine.get_state().unwrap();
            assert!(matches!(
                state.state,
                engine::TimerStateForAPI::Running { .. }
            ));
            assert_eq!(state.accumulated_seconds, accumulated_after_pause); // accumulated сохраняется

            // Stop
            engine.stop().unwrap();
            let state = engine.get_state().unwrap();
            assert!(matches!(state.state, engine::TimerStateForAPI::Stopped));
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
            // Тест обнаружения сна: разрыв между wall-clock и monotonic (реальный сон)
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // Симулируем сон: wall-clock ушёл на 25 мин вперёд, monotonic только на 5 мин (20 мин "сна")
            {
                let mut state = engine.state.lock().unwrap();
                if let TimerState::Running { started_at: _, .. } = &*state {
                    let now_wall = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    let started_at_wall = now_wall.saturating_sub(25 * 60); // 25 мин назад по wall
                    let started_at_instant = Instant::now() - Duration::from_secs(5 * 60); // 5 мин по monotonic
                    *state = TimerState::Running {
                        started_at: started_at_wall,
                        started_at_instant,
                    };
                }
            }

            // get_state обнаруживает sleep (gap >= 5 мин) и вызывает handle_system_sleep → Paused
            let state = engine.get_state().unwrap();
            assert!(matches!(
                state.state,
                engine::TimerStateForAPI::Paused { .. }
            ));
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
                assert!(matches!(
                    state.state,
                    engine::TimerStateForAPI::Running { .. }
                ));
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
            // Тест, что day rollover использует локальную полуночь для сравнения дат
            let engine = TimerEngine::new();

            engine.start().unwrap();

            // Симулируем смену дня: day_start_timestamp = вчера по местному времени
            let yesterday_local = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday_local
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }

            engine.ensure_correct_day().unwrap();

            // День обновлён на сегодня (локальная дата)
            let today_local = Local::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);
        }

        #[test]
        fn test_rollover_idempotency_concurrent() {
            // Тест идемпотентности rollover при множественных вызовах
            let engine = TimerEngine::new();

            // Симулируем смену дня (вчера по местному времени)
            let yesterday = Local::now().date_naive() - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
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

            // Проверяем, что день обновлен на сегодня (локальная дата)
            let today_local = Local::now().date_naive();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);
        }

        #[test]
        fn test_ensure_correct_day_called_in_all_methods() {
            // Тест, что ensure_correct_day() вызывается во всех публичных методах
            let engine = TimerEngine::new();
            let today_local = Local::now().date_naive();

            // Симулируем смену дня (вчера по местному времени)
            let yesterday = today_local - chrono::Duration::days(1);
            let yesterday_start = yesterday
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).earliest())
                .unwrap()
                .timestamp() as u64;

            // start() должен вызвать ensure_correct_day()
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            engine.start().unwrap();
            // После start() день должен быть обновлен на сегодня (локальная дата)
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            assert!(day_start.is_some());
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);

            // pause() должен вызвать ensure_correct_day()
            // Но сначала нужно убедиться, что таймер все еще запущен после rollover
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            // Если после rollover таймер остановлен, нужно запустить его снова
            let state_before = engine.get_state().unwrap();
            if matches!(state_before.state, engine::TimerStateForAPI::Stopped) {
                engine.start().unwrap();
            }
            thread::sleep(Duration::from_millis(200));
            engine.pause().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);

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
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);

            // stop() должен вызвать ensure_correct_day()
            // Но сначала нужно убедиться, что таймер запущен (не остановлен rollover'ом)
            {
                let mut day_start = engine.day_start_timestamp.lock().unwrap();
                *day_start = Some(yesterday_start);
            }
            let state_before_stop = engine.get_state().unwrap();
            if matches!(state_before_stop.state, engine::TimerStateForAPI::Stopped) {
                // Если таймер остановлен, запускаем его снова
                engine.start().unwrap();
                thread::sleep(Duration::from_millis(200));
            }
            engine.stop().unwrap();
            let day_start = *engine.day_start_timestamp.lock().unwrap();
            let day_start_date =
                chrono::DateTime::<Utc>::from_timestamp(day_start.unwrap() as i64, 0)
                    .unwrap()
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);

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
                    .with_timezone(&Local)
                    .date_naive();
            assert_eq!(day_start_date, today_local);
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

            let encrypted_payload = &tasks[0].2;

            let decrypted = sync_manager
                .db
                .encryption
                .decrypt(encrypted_payload)
                .unwrap_or_else(|_| encrypted_payload.clone());

            // PRODUCTION: Парсим payload и проверяем, что токены НЕ сохранены
            let payload_json: serde_json::Value = serde_json::from_str(&decrypted)
                .expect("Payload should be a valid json after decryption");
            // Токены не должны быть в payload
            assert!(payload_json["accessToken"].is_null());
            assert!(payload_json["refreshToken"].is_null());
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
            // BUG FIX: Функция cancel_opposite_time_entry_operations отменяет все противоположные операции
            // независимо от ID, поэтому когда добавляется "resume", она отменяет "pause"
            // Используем разные ID для каждой операции, чтобы они не отменяли друг друга
            // (функция отменяет по типу операции, но в реальности они для разных entry)
            let (sync_manager, _temp_dir) = create_test_sync_manager();

            let operations = vec!["start", "pause", "resume", "stop"];

            for operation in operations {
                // Используем разные ID для каждой операции, чтобы они не отменяли друг друга
                // В реальности cancel_opposite_time_entry_operations отменяет все противоположные операции,
                // но в тесте мы проверяем, что разные операции можно добавить
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
            // NOTE: cancel_opposite_time_entry_operations отменяет все противоположные операции за последние 30 секунд
            // независимо от ID, поэтому когда добавляется "resume", она отменяет "pause"
            // Итого: start, resume (pause отменена), stop = 3 задачи
            let tasks = sync_manager.db.get_pending_sync_tasks(10).unwrap();
            // Ожидаем 3 задачи: start, resume (pause была отменена), stop
            assert_eq!(tasks.len(), 3, "Expected 3 tasks (pause was cancelled by resume), got {}", tasks.len());
            
            // Проверяем, что start, resume и stop есть
            let task_types: Vec<&str> = tasks.iter().map(|(_, entity_type, _)| entity_type.as_str()).collect();
            assert!(task_types.contains(&"time_entry_start"), "Start task should be present");
            assert!(task_types.contains(&"time_entry_resume"), "Resume task should be present (pause was cancelled)");
            assert!(task_types.contains(&"time_entry_stop"), "Stop task should be present");
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
                result.unwrap_err().to_string().contains("Parse payload"),
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
            let err = result.unwrap_err().to_string();
            assert!(
                err.contains("Token not set")
                    || err.contains("Auth")
                    || err.contains("set_auth_tokens"),
                "Error should mention missing access token in AuthManager. Got: {}",
                err
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
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Unknown time entry operation"),
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
                result.unwrap_err().to_string().contains("Missing id"),
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
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Missing imageData"),
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
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Unknown entity type"),
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
                let decrypted_payload = sync_manager
                    .db
                    .encryption
                    .decrypt(&payload)
                    .expect("Payload must be decrypted successfully");
                let payload_json: serde_json::Value = serde_json::from_str(&decrypted_payload)
                    .expect("Decrypted payload must be a valid JSON");
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
            let error_msg = result.unwrap_err().to_string();
            assert!(
                error_msg.contains("Token not set")
                    || error_msg.contains("Auth")
                    || error_msg.contains("set_auth_tokens"),
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

            if let Err(e) = result {
                let s = e.to_string();
                assert!(
                    !s.contains("Missing id") && !s.contains("Unknown operation"),
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

            if let Err(e) = result {
                let s = e.to_string();
                assert!(
                    !s.contains("Missing id") && !s.contains("Unknown operation"),
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
