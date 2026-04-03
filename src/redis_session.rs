use redis::aio::ConnectionManager;
use redis::AsyncCommands;

use crate::error::{AppError, Result};
use crate::models::Session;

const RATE_LIMIT_PREFIX: &str = "rl:";

const SESSION_PREFIX: &str = "session:";
const SESSION_TTL_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
const AUTH_CODE_PREFIX: &str = "auth_code:";
const AUTH_CODE_TTL_SECS: u64 = 60; // 1 minute

#[derive(Clone)]
pub struct RedisClient {
    conn: ConnectionManager,
}

impl RedisClient {
    /// 内部 ConnectionManager へのアクセス（session_state 等から利用）
    pub fn conn(&self) -> &ConnectionManager {
        &self.conn
    }
}

impl RedisClient {
    pub async fn new(redis_url: &str) -> std::result::Result<Self, String> {
        let client = redis::Client::open(redis_url)
            .map_err(|e| format!("Redis client creation failed: {}", e))?;
        let conn = ConnectionManager::new(client)
            .await
            .map_err(|e| format!("Redis connection failed: {}", e))?;
        Ok(Self { conn })
    }

    fn session_key(session_id: &str) -> String {
        format!("{}{}", SESSION_PREFIX, session_id)
    }

    pub async fn put_session(&self, session: &Session) -> Result<()> {
        let mut conn = self.conn.clone();
        let key = Self::session_key(&session.id);
        let json = serde_json::to_string(session)
            .map_err(|e| AppError::Internal(format!("Failed to serialize session: {}", e)))?;
        conn.set_ex::<_, _, ()>(&key, &json, SESSION_TTL_SECS)
            .await
            .map_err(|e| AppError::Redis(format!("Redis put_session failed: {}", e)))?;
        Ok(())
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let mut conn = self.conn.clone();
        let key = Self::session_key(session_id);
        let value: Option<String> = conn
            .get(&key)
            .await
            .map_err(|e| AppError::Redis(format!("Redis get_session failed: {}", e)))?;
        match value {
            Some(json) => {
                let session: Session = serde_json::from_str(&json)
                    .map_err(|e| AppError::Internal(format!("Failed to deserialize session: {}", e)))?;
                Ok(Some(session))
            }
            None => Ok(None),
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let mut conn = self.conn.clone();
        let key = Self::session_key(session_id);
        conn.del::<_, ()>(&key)
            .await
            .map_err(|e| AppError::Redis(format!("Redis delete_session failed: {}", e)))?;
        Ok(())
    }

    /// OAuth 認可コードの一時保存 (60秒 TTL、1回限り)
    pub async fn put_auth_code(&self, code: &str, data: &str) -> Result<()> {
        let mut conn = self.conn.clone();
        let key = format!("{}{}", AUTH_CODE_PREFIX, code);
        conn.set_ex::<_, _, ()>(&key, data, AUTH_CODE_TTL_SECS)
            .await
            .map_err(|e| AppError::Redis(format!("Redis put_auth_code failed: {}", e)))?;
        Ok(())
    }

    /// OAuth 認可コードの取得と即座の削除 (1回限り)
    pub async fn take_auth_code(&self, code: &str) -> Result<Option<String>> {
        let mut conn = self.conn.clone();
        let key = format!("{}{}", AUTH_CODE_PREFIX, code);
        let value: Option<String> = conn
            .get(&key)
            .await
            .map_err(|e| AppError::Redis(format!("Redis take_auth_code failed: {}", e)))?;
        if value.is_some() {
            conn.del::<_, ()>(&key)
                .await
                .map_err(|e| AppError::Redis(format!("Redis del auth_code failed: {}", e)))?;
        }
        Ok(value)
    }

    /// レートリミットチェック (sliding window counter)
    /// key_suffix: エンドポイント+識別子 (例: "login:user@example.com")
    /// max_requests: ウィンドウ内の最大リクエスト数
    /// window_secs: ウィンドウ期間 (秒)
    /// 戻り値: Ok(remaining) or Err(TooManyRequests)
    pub async fn check_rate_limit(
        &self,
        key_suffix: &str,
        max_requests: u64,
        window_secs: u64,
    ) -> Result<u64> {
        let mut conn = self.conn.clone();
        let key = format!("{}{}", RATE_LIMIT_PREFIX, key_suffix);
        let count: u64 = conn
            .incr(&key, 1u64)
            .await
            .map_err(|e| AppError::Redis(format!("Redis rate limit failed: {}", e)))?;
        if count == 1 {
            // 新しいキー → TTL 設定
            let _: () = conn
                .expire(&key, window_secs as i64)
                .await
                .map_err(|e| AppError::Redis(format!("Redis expire failed: {}", e)))?;
        }
        if count > max_requests {
            return Err(AppError::TooManyRequests(format!(
                "Rate limit exceeded. Try again in {} seconds",
                window_secs
            )));
        }
        Ok(max_requests - count)
    }
}
