use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};

use crate::models::TokenRefreshResult;
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Ошибки аутентификации (для разбора и логирования)
#[derive(Debug)]
pub enum AuthError {
    TokenNotSet(String),
    Network(String),
    Http { status: u16 },
    Parse(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::TokenNotSet(s) => write!(f, "Token not set: {}", s),
            AuthError::Network(s) => write!(f, "Network: {}", s),
            AuthError::Http { status } => write!(f, "HTTP {}", status),
            AuthError::Parse(s) => write!(f, "Parse: {}", s),
        }
    }
}

/// Конфигурация AuthManager (api_base_url, таймаут HTTP)
#[derive(Clone)]
pub struct AuthConfig {
    pub api_base_url: String,
    pub http_timeout_secs: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            api_base_url: "https://app.automatonsoft.de/api".to_string(),
            http_timeout_secs: 10,
        }
    }
}

/// Менеджер аутентификации для получения токенов
/// Получает токены из localStorage через Tauri команду
pub struct AuthManager {
    api_base_url: String,
    client: reqwest::Client,
    pub access_token: Arc<tokio::sync::RwLock<Option<String>>>,
    pub refresh_token: Arc<tokio::sync::RwLock<Option<String>>>,
}

impl AuthManager {
    pub fn new(api_base_url: String) -> Self {
        Self::new_with_config(AuthConfig {
            api_base_url,
            http_timeout_secs: 10,
        })
    }

    pub fn new_with_config(config: AuthConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.http_timeout_secs))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            api_base_url: config.api_base_url.clone(),
            client,
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
    pub async fn get_access_token(&self) -> Result<String, AuthError> {
        self.access_token
            .read()
            .await
            .clone()
            .ok_or_else(|| AuthError::TokenNotSet("Call set_auth_tokens first.".into()))
    }

    /// Получить refresh token
    pub async fn get_refresh_token(&self) -> Result<Option<String>, AuthError> {
        Ok(self.refresh_token.read().await.clone())
    }

    /// Обновить токен через refresh token
    pub async fn refresh_token(
        &self,
        refresh_token: &str,
    ) -> Result<TokenRefreshResult, AuthError> {
        let url = format!("{}/auth/refresh", self.api_base_url);
        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| AuthError::Network(e.to_string()))?;

        let status = response.status();
        if !status.is_success() {
            return Err(AuthError::Http {
                status: status.as_u16(),
            });
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AuthError::Parse(e.to_string()))?;

        let access_token = json["access_token"]
            .as_str()
            .ok_or_else(|| AuthError::Parse("Missing access_token in refresh response".into()))?
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
pub struct TokenEncryption {
    cipher: Aes256Gcm,
}

const KEYRING_SERVICE: &str = "com.balabiturembek.hubnity";
const KEYRING_USER: &str = "encryption_key";

impl TokenEncryption {
    /// Создать новый экземпляр с ключом из:
    /// 1. HUBNITY_ENCRYPTION_KEY (hex) env var
    /// 2. OS Keychain (macOS) / Credential Manager (Windows) / Secret Service (Linux)
    /// 3. Fallback: randomly generated key stored in app_data_dir (never hardcoded)
    pub fn new(app_data_dir: Option<&Path>) -> Result<Self, String> {
        let key = Self::resolve_encryption_key(app_data_dir)?;

        if key.len() != 32 {
            return Err("Encryption key must be 32 bytes".to_string());
        }

        let key_array: [u8; 32] = key
            .try_into()
            .map_err(|_| "Failed to convert key to array".to_string())?;

        let cipher = Aes256Gcm::new(&key_array.into());

        Ok(Self { cipher })
    }

    fn resolve_encryption_key(app_data_dir: Option<&Path>) -> Result<Vec<u8>, String> {
        // 1. Env var (hex) - for CI/deployment override
        if let Ok(env_key) = std::env::var("HUBNITY_ENCRYPTION_KEY") {
            if let Ok(decoded) = hex::decode(env_key.trim()) {
                if decoded.len() == 32 {
                    return Ok(decoded);
                }
            }
        }

        // 2. Fallback file only — keychain disabled on macOS (causes repeated prompts even with "Always Allow")
        // File is in app_data_dir, protected by OS. Zero keychain prompts.
        if let Some(dir) = app_data_dir {
            if let Ok(key) = Self::get_key_from_fallback_file(dir) {
                return Ok(key);
            }
            if let Ok(key) = Self::create_fallback_key_only(dir) {
                return Ok(key);
            }
        }

        Err(
            "Encryption key unavailable: set HUBNITY_ENCRYPTION_KEY (hex), or ensure app data dir is writable".to_string(),
        )
    }

    /// Read key from fallback file (no keychain access)
    fn get_key_from_fallback_file(app_data_dir: &Path) -> Result<Vec<u8>, String> {
        let key_file = app_data_dir.join(".hubnity_encryption_key");
        if !key_file.exists() {
            return Err("Fallback key file does not exist".to_string());
        }
        let hex_key =
            fs::read_to_string(&key_file).map_err(|e| format!("Failed to read key file: {}", e))?;
        let key = hex::decode(hex_key.trim()).map_err(|e| format!("Invalid key hex: {}", e))?;
        if key.len() == 32 {
            Ok(key)
        } else {
            Err("Key file invalid length".to_string())
        }
    }

    /// Create new key and save to fallback file only (avoids keychain prompt loop on macOS)
    fn create_fallback_key_only(app_data_dir: &Path) -> Result<Vec<u8>, String> {
        let key_file = app_data_dir.join(".hubnity_encryption_key");
        let key: [u8; 32] = rand::random();
        let hex_key = hex::encode(key);
        fs::write(&key_file, hex_key).map_err(|e| format!("Failed to write key file: {}", e))?;
        Ok(key.to_vec())
    }

    #[allow(dead_code)]
    fn get_key_from_keyring() -> Result<Vec<u8>, String> {
        use keyring::Entry;
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Keyring entry creation failed: {}", e))?;
        let hex_key = entry
            .get_password()
            .map_err(|e| format!("Keyring get failed: {}", e))?;
        hex::decode(hex_key.trim()).map_err(|e| format!("Key hex decode failed: {}", e))
    }

    #[allow(dead_code)]
    fn set_key_in_keyring(key: &[u8]) -> Result<(), String> {
        use keyring::Entry;
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Keyring entry creation failed: {}", e))?;
        entry
            .set_password(&hex::encode(key))
            .map_err(|e| format!("Keyring set failed: {}", e))
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

    /// Расшифровать с миграцией: при неудаче пробует legacy-ключ.
    /// Возвращает (plaintext, true) если использован legacy — вызывающий код должен перешифровать и сохранить.
    pub fn decrypt_with_legacy_fallback(&self, encrypted: &str) -> Result<(String, bool), String> {
        match self.decrypt(encrypted) {
            Ok(plaintext) => Ok((plaintext, false)),
            Err(_) => {
                if let Ok(plaintext) = Self::legacy_decrypt(encrypted) {
                    tracing::warn!(
                        "[AUTH] Migration: decrypted with legacy key, re-encrypt recommended"
                    );
                    Ok((plaintext, true))
                } else {
                    Err("Decryption failed with both current and legacy keys".to_string())
                }
            }
        }
    }

    /// Расшифровать legacy-данные (pre-keyring ключ)
    fn legacy_decrypt(encrypted: &str) -> Result<String, String> {
        use base64::{engine::general_purpose, Engine as _};
        let data = general_purpose::STANDARD
            .decode(encrypted)
            .map_err(|e| format!("Base64 decode failed: {}", e))?;

        if data.len() < 12 {
            return Err("Invalid encrypted data length".to_string());
        }

        let legacy_key: [u8; 32] = *b"default-encryption-key-32-bytes!";
        let legacy_cipher = Aes256Gcm::new(&legacy_key.into());

        let nonce = Nonce::from_slice(&data[..12]);
        let ciphertext = &data[12..];

        let plaintext = legacy_cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| format!("Legacy decryption failed: {}", e))?;

        String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
    }
}
