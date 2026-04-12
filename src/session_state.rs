//! Redis ベースのステート管理
//!
//! ユーザ State:
//!   - None (情報なし)
//!   - LoggedIn (ログイン状態)
//!   - SessionExpired (セッション切れ)
//!
//! ユーザデータ State (各モジュールごと):
//!   - None (情報なし)
//!   - Exists (情報あり)
//!   - Updated (更新あり)
//!
//! これらはモデルキャッシュと同義であり、全て Redis に保存される。

use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::redis_session::RedisClient;

// ── ユーザ State ────────────────────────────────────

/// ユーザのセッション状態
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserState {
    /// 情報なし — セッション未確立
    None,
    /// ログイン状態
    LoggedIn,
    /// セッション切れ
    SessionExpired,
}

impl std::fmt::Display for UserState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "none"),
            Self::LoggedIn => write!(f, "logged_in"),
            Self::SessionExpired => write!(f, "session_expired"),
        }
    }
}

impl std::str::FromStr for UserState {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "none" => Ok(Self::None),
            "logged_in" => Ok(Self::LoggedIn),
            "session_expired" => Ok(Self::SessionExpired),
            _ => Err(format!("Unknown user state: {}", s)),
        }
    }
}

// ── ユーザデータ State (モジュール単位) ─────────────

/// 各モジュールのユーザデータ状態
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataState {
    /// 情報なし
    None,
    /// 情報あり
    Exists,
    /// 更新あり
    Updated,
}

impl std::fmt::Display for DataState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "none"),
            Self::Exists => write!(f, "exists"),
            Self::Updated => write!(f, "updated"),
        }
    }
}

impl std::str::FromStr for DataState {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "none" => Ok(Self::None),
            "exists" => Ok(Self::Exists),
            "updated" => Ok(Self::Updated),
            _ => Err(format!("Unknown data state: {}", s)),
        }
    }
}

/// モジュールごとのデータ状態エントリ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleDataState {
    pub module: String,
    pub state: DataState,
    pub version: u64,
    pub updated_at: i64,
}

/// ユーザの全ステート (Redis に一括保存)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserFullState {
    pub user_id: Uuid,
    pub session_id: String,
    pub state: UserState,
    pub modules: Vec<ModuleDataState>,
    pub last_ping_at: i64,
}

// ── Redis キー規約 ──────────────────────────────────

const USER_STATE_PREFIX: &str = "ustate:";
#[allow(dead_code)]
const MODULE_STATE_PREFIX: &str = "mstate:";
/// ユーザステートの TTL: セッション TTL と同じ 7 日
const STATE_TTL_SECS: u64 = 7 * 24 * 60 * 60;

fn user_state_key(user_id: &Uuid) -> String {
    format!("{}{}", USER_STATE_PREFIX, user_id)
}

#[allow(dead_code)]
fn module_state_key(user_id: &Uuid, module: &str) -> String {
    format!("{}{}:{}", MODULE_STATE_PREFIX, user_id, module)
}

// ── RedisClient 拡張 ────────────────────────────────

impl RedisClient {
    // ── ユーザ State ────────────────────────────────

    pub async fn set_user_state(&self, state: &UserFullState) -> Result<()> {
        let mut conn = self.conn().clone();
        let key = user_state_key(&state.user_id);
        let json = serde_json::to_string(state)
            .map_err(|e| AppError::Internal(format!("Serialize user state: {}", e)))?;
        conn.set_ex::<_, _, ()>(&key, &json, STATE_TTL_SECS)
            .await
            .map_err(|e| AppError::Redis(format!("set_user_state: {}", e)))?;
        Ok(())
    }

    pub async fn get_user_state(&self, user_id: &Uuid) -> Result<Option<UserFullState>> {
        let mut conn = self.conn().clone();
        let key = user_state_key(user_id);
        let value: Option<String> = conn
            .get(&key)
            .await
            .map_err(|e| AppError::Redis(format!("get_user_state: {}", e)))?;
        match value {
            Some(json) => {
                let state: UserFullState = serde_json::from_str(&json)
                    .map_err(|e| AppError::Internal(format!("Deserialize user state: {}", e)))?;
                Ok(Some(state))
            }
            None => Ok(None),
        }
    }

    #[allow(dead_code)]
    pub async fn delete_user_state(&self, user_id: &Uuid) -> Result<()> {
        let mut conn = self.conn().clone();
        let key = user_state_key(user_id);
        conn.del::<_, ()>(&key)
            .await
            .map_err(|e| AppError::Redis(format!("delete_user_state: {}", e)))?;
        Ok(())
    }

    pub async fn update_user_state_field(
        &self,
        user_id: &Uuid,
        new_state: UserState,
    ) -> Result<()> {
        if let Some(mut full) = self.get_user_state(user_id).await? {
            full.state = new_state;
            self.set_user_state(&full).await?;
        }
        Ok(())
    }

    pub async fn update_last_ping(&self, user_id: &Uuid, timestamp: i64) -> Result<()> {
        if let Some(mut full) = self.get_user_state(user_id).await? {
            full.last_ping_at = timestamp;
            self.set_user_state(&full).await?;
        }
        Ok(())
    }

    // ── モジュール Data State ───────────────────────

    #[allow(dead_code)]
    pub async fn set_module_state(
        &self,
        user_id: &Uuid,
        module: &ModuleDataState,
    ) -> Result<()> {
        let mut conn = self.conn().clone();
        let key = module_state_key(user_id, &module.module);
        let json = serde_json::to_string(module)
            .map_err(|e| AppError::Internal(format!("Serialize module state: {}", e)))?;
        conn.set_ex::<_, _, ()>(&key, &json, STATE_TTL_SECS)
            .await
            .map_err(|e| AppError::Redis(format!("set_module_state: {}", e)))?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn get_module_state(
        &self,
        user_id: &Uuid,
        module: &str,
    ) -> Result<Option<ModuleDataState>> {
        let mut conn = self.conn().clone();
        let key = module_state_key(user_id, module);
        let value: Option<String> = conn
            .get(&key)
            .await
            .map_err(|e| AppError::Redis(format!("get_module_state: {}", e)))?;
        match value {
            Some(json) => {
                let state: ModuleDataState = serde_json::from_str(&json)
                    .map_err(|e| AppError::Internal(format!("Deserialize module state: {}", e)))?;
                Ok(Some(state))
            }
            None => Ok(None),
        }
    }

    #[allow(dead_code)]
    pub async fn delete_module_state(&self, user_id: &Uuid, module: &str) -> Result<()> {
        let mut conn = self.conn().clone();
        let key = module_state_key(user_id, module);
        conn.del::<_, ()>(&key)
            .await
            .map_err(|e| AppError::Redis(format!("delete_module_state: {}", e)))?;
        Ok(())
    }
}
