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

// ── ツールクライアント (Tool Authentication) ──────

/// ツールクライアント
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ToolClient {
    pub id: Uuid,
    pub name: String,
    pub client_id: String,
    pub client_secret_hash: String,
    pub owner_user_id: Uuid,
    pub scopes: serde_json::Value,
    pub is_active: bool,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// ツールクライアントレスポンス (シークレットは含まない)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolClientResponse {
    pub id: String,
    pub name: String,
    pub client_id: String,
    pub owner_user_id: String,
    pub scopes: Vec<String>,
    pub is_active: bool,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<ToolClient> for ToolClientResponse {
    fn from(tc: ToolClient) -> Self {
        let scopes: Vec<String> = serde_json::from_value(tc.scopes).unwrap_or_default();
        Self {
            id: tc.id.to_string(),
            name: tc.name,
            client_id: tc.client_id,
            owner_user_id: tc.owner_user_id.to_string(),
            scopes,
            is_active: tc.is_active,
            last_used_at: tc.last_used_at.map(|t| t.to_rfc3339()),
            created_at: tc.created_at.to_rfc3339(),
            updated_at: tc.updated_at.to_rfc3339(),
        }
    }
}

/// ツール認証用 JWT クレーム
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolJwtClaims {
    pub sub: String,          // tool_client.id
    pub owner: String,        // owner_user_id
    pub scopes: Vec<String>,
    pub exp: usize,
    pub iat: usize,
}

// ── ユーザープロファイル (パーソナリティデータ) ────

/// ユーザープロファイル
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserProfile {
    pub user_id: Uuid,
    pub role_title: String,
    pub bio: String,
    pub expertise: serde_json::Value,
    pub hobbies: serde_json::Value,
    pub extra: serde_json::Value,
    pub privacy: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// プロファイルプライバシー設定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePrivacy {
    #[serde(default = "default_true")]
    pub bio: bool,
    #[serde(default = "default_true")]
    pub role_title: bool,
    #[serde(default = "default_true")]
    pub expertise: bool,
    #[serde(default = "default_true")]
    pub hobbies: bool,
}

fn default_true() -> bool { true }

impl Default for ProfilePrivacy {
    fn default() -> Self {
        Self { bio: true, role_title: true, expertise: true, hobbies: true }
    }
}

/// プロファイルレスポンス (自分用 — 全フィールド含む)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileResponse {
    pub user_id: String,
    pub role_title: String,
    pub bio: String,
    pub expertise: Vec<String>,
    pub hobbies: Vec<String>,
    pub extra: serde_json::Value,
    pub privacy: ProfilePrivacy,
    pub created_at: String,
    pub updated_at: String,
}

impl From<UserProfile> for UserProfileResponse {
    fn from(p: UserProfile) -> Self {
        let privacy: ProfilePrivacy = serde_json::from_value(p.privacy).unwrap_or_default();
        Self {
            user_id: p.user_id.to_string(),
            role_title: p.role_title,
            bio: p.bio,
            expertise: serde_json::from_value(p.expertise).unwrap_or_default(),
            hobbies: serde_json::from_value(p.hobbies).unwrap_or_default(),
            extra: p.extra,
            privacy,
            created_at: p.created_at.to_rfc3339(),
            updated_at: p.updated_at.to_rfc3339(),
        }
    }
}

/// 公開プロファイルレスポンス (プライバシー設定に従いフィルタ済み)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfileResponse {
    pub user_id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expertise: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hobbies: Option<Vec<String>>,
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

// ── サービスレジストリ (3点方式認証) ────────────────

/// 登録済みサービス
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ServiceEntry {
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub service_secret_hash: String,
    pub endpoint_url: String,
    pub scopes: serde_json::Value,
    pub is_active: bool,
    pub last_connected_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// サービス一覧レスポンス (secret除外)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResponse {
    pub id: String,
    pub code: String,
    pub name: String,
    pub endpoint_url: String,
    pub scopes: serde_json::Value,
    pub is_active: bool,
    pub is_connected: bool,
    pub last_connected_at: Option<String>,
}

/// サービスチケット (ワンタイム)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ServiceTicket {
    pub id: Uuid,
    pub user_id: Uuid,
    pub service_id: Uuid,
    pub ticket_code: String,
    pub user_data: serde_json::Value,
    pub organization_id: Option<Uuid>,
    pub scopes: serde_json::Value,
    pub expires_at: DateTime<Utc>,
    pub consumed: bool,
    pub created_at: DateTime<Utc>,
}

/// サービスアクセスレスポンス (ブラウザに返す)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccessResponse {
    pub service_token: String,
    pub service_url: String,
    pub service_code: String,
    pub expires_in: i64,
}
