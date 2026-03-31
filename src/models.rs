use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// ユーザー情報 (GitHub / Google / パスワード認証対応)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub github_id: Option<i64>,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub role: String,
    pub password_hash: Option<String>,
    pub google_id: Option<String>,
    pub google_access_token: Option<String>,
    pub google_refresh_token: Option<String>,
    pub google_token_expires_at: Option<i64>,
    pub google_scopes: Option<serde_json::Value>,
    pub totp_secret: Option<String>,
    pub totp_enabled: bool,
    pub phone_number: Option<String>,
    pub phone_verified: bool,
    pub mfa_enabled: bool,
    pub mfa_methods: serde_json::Value,
    pub last_login_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Redis セッション (Cookie ベース、Ars BFF 用)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub user_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub access_token: String,
}

/// JWT リフレッシュセッション (DB 管理)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RefreshSession {
    pub id: Uuid,
    pub user_id: Uuid,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
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

/// Ars Editor 向け User レスポンス（camelCase, Cookie ベースの /auth/me 用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    pub id: String,
    pub github_id: Option<i64>,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub role: String,
    pub has_google_auth: bool,
    pub has_password: bool,
    pub mfa_enabled: bool,
    pub mfa_methods: Vec<String>,
    pub has_phone: bool,
    pub phone_verified: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<User> for UserResponse {
    fn from(u: User) -> Self {
        let mfa_methods: Vec<String> = serde_json::from_value(u.mfa_methods.clone())
            .unwrap_or_default();
        Self {
            id: u.id.to_string(),
            github_id: u.github_id,
            login: u.login,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
            email: u.email,
            role: u.role,
            has_google_auth: u.google_id.is_some(),
            has_password: u.password_hash.is_some(),
            mfa_enabled: u.mfa_enabled,
            mfa_methods,
            has_phone: u.phone_number.is_some(),
            phone_verified: u.phone_verified,
            created_at: u.created_at.to_rfc3339(),
            updated_at: u.updated_at.to_rfc3339(),
        }
    }
}

/// 検証コード (SMS / メール OTP)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct VerificationCode {
    pub id: Uuid,
    pub user_id: Uuid,
    pub code: String,
    pub method: String,
    pub expires_at: DateTime<Utc>,
    pub used: bool,
    pub created_at: DateTime<Utc>,
}

// ── 組織 (Organization) ────────────────────────────

/// 組織
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 組織メンバー
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OrganizationMember {
    pub organization_id: Uuid,
    pub user_id: Uuid,
    pub role: String, // owner / admin / member
    pub joined_at: DateTime<Utc>,
}

/// 組織メンバー（ユーザー情報付き）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OrganizationMemberWithUser {
    pub organization_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub last_login_at: Option<DateTime<Utc>>,
}

/// 組織レスポンス
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationResponse {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Organization> for OrganizationResponse {
    fn from(o: Organization) -> Self {
        Self {
            id: o.id.to_string(),
            name: o.name,
            slug: o.slug,
            description: o.description,
            created_by: o.created_by.to_string(),
            created_at: o.created_at.to_rfc3339(),
            updated_at: o.updated_at.to_rfc3339(),
        }
    }
}

/// メンバーレスポンス
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberResponse {
    pub user_id: String,
    pub role: String,
    pub joined_at: String,
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
    pub email: Option<String>,
    pub last_login_at: Option<String>,
}

impl From<OrganizationMemberWithUser> for MemberResponse {
    fn from(m: OrganizationMemberWithUser) -> Self {
        Self {
            user_id: m.user_id.to_string(),
            role: m.role,
            joined_at: m.joined_at.to_rfc3339(),
            login: m.login,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            email: m.email,
            last_login_at: m.last_login_at.map(|t| t.to_rfc3339()),
        }
    }
}

// ── プロジェクト定義 ───────────────────────────────

/// プロジェクト定義 (Ars, Schedula などのプロジェクトタイプ)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProjectDefinition {
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub data_schema: serde_json::Value,
    pub commands: serde_json::Value,
    pub plugin_repository: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// プロジェクト定義レスポンス
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDefinitionResponse {
    pub id: String,
    pub code: String,
    pub name: String,
    pub data_schema: serde_json::Value,
    pub commands: serde_json::Value,
    pub plugin_repository: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<ProjectDefinition> for ProjectDefinitionResponse {
    fn from(p: ProjectDefinition) -> Self {
        Self {
            id: p.id.to_string(),
            code: p.code,
            name: p.name,
            data_schema: p.data_schema,
            commands: p.commands,
            plugin_repository: p.plugin_repository,
            created_at: p.created_at.to_rfc3339(),
            updated_at: p.updated_at.to_rfc3339(),
        }
    }
}

/// JWT クレーム
#[derive(Debug, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,       // user_id
    pub role: String,
    pub exp: usize,
    pub iat: usize,
}

/// JWT トークンペアレスポンス
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub user: UserResponse,
    pub access_token: String,
    pub refresh_token: String,
}

/// MFA チャレンジレスポンス (ログイン時に MFA が必要な場合)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaChallengeResponse {
    pub mfa_required: bool,
    pub mfa_token: String,
    pub mfa_methods: Vec<String>,
}

/// MFA クレーム (一時トークン)
#[derive(Debug, Serialize, Deserialize)]
pub struct MfaClaims {
    pub sub: String,       // user_id
    pub purpose: String,   // "mfa_challenge"
    pub exp: usize,
    pub iat: usize,
}
