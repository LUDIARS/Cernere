use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// ユーザー情報
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub github_id: i64,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// セッション情報（Redis に保存）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub user_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    /// GitHub アクセストークン（Redis にのみ保持）
    pub access_token: String,
}

/// プロジェクト（DBレコード）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Project {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub data: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

/// プロジェクト一覧用のサマリー
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProjectSummary {
    pub id: Uuid,
    pub name: String,
    pub updated_at: DateTime<Utc>,
}

/// プロジェクト設定
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProjectSetting {
    pub project_id: Uuid,
    pub setting_key: String,
    pub value: String,
    pub updated_at: DateTime<Utc>,
}

/// Ars Editor 向け User レスポンス（camelCase）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    pub id: String,
    pub github_id: i64,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<User> for UserResponse {
    fn from(u: User) -> Self {
        Self {
            id: u.id.to_string(),
            github_id: u.github_id,
            login: u.login,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
            email: u.email,
            created_at: u.created_at.to_rfc3339(),
            updated_at: u.updated_at.to_rfc3339(),
        }
    }
}
