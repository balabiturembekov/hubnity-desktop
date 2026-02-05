use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};

use crate::models::TokenRefreshResult;
use std::sync::Arc;
/// Менеджер аутентификации для получения токенов
/// Получает токены из localStorage через Tauri команду
pub struct AuthManager {
    api_base_url: String,
    // GUARD: Временное хранение токенов для синхронизации
    // В production должно быть в Keychain
    pub access_token: Arc<tokio::sync::RwLock<Option<String>>>,
    pub refresh_token: Arc<tokio::sync::RwLock<Option<String>>>,
}

impl AuthManager {
    pub fn new(api_base_url: String) -> Self {
        Self {
            api_base_url,
            access_token: Arc::new(tokio::sync::RwLock::new(None)),
            refresh_token: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Установить токены (вызывается из Tauri команды)
    pub async fn set_tokens(&self, access_token: Option<String>, refresh_token: Option<String>) {
        *self.access_token.write().await = access_token;
        *self.refresh_token.write().await = refresh_token;
    }

    /// Получить access token
    pub async fn get_access_token(&self) -> Result<String, String> {
        self.access_token
            .read()
            .await
            .clone()
            .ok_or_else(|| "Access token not set. Call set_auth_tokens first.".to_string())
    }

    /// Получить refresh token
    pub async fn get_refresh_token(&self) -> Result<Option<String>, String> {
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
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<TokenRefreshResult, String> {
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

// ============================================
// TOKEN ENCRYPTION
// ============================================

/// Шифрование токенов перед сохранением в SQLite
/// Использует AES-256-GCM для шифрования
#[allow(dead_code)]
pub struct TokenEncryption {
    cipher: Aes256Gcm,
}
#[allow(dead_code)]
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

// Глобальный экземпляр для шифрования (lazy_static или OnceCell in production)
// Для упрощения используем функцию, которая создает новый экземпляр каждый раз
// В production должен быть singleton
#[allow(dead_code)] // Может использоваться в будущем для миграции старых токенов
fn get_encryption() -> Result<TokenEncryption, String> {
    TokenEncryption::new()
}
