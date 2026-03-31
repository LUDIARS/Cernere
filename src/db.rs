use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::{Project, ProjectSetting, ProjectSummary, RefreshSession, User, VerificationCode};

// ── User ────────────────────────────────────────────

pub async fn upsert_user(pool: &PgPool, user: &User) -> Result<()> {
    sqlx::query(
        "INSERT INTO users (id, github_id, login, display_name, avatar_url, email, role,
                            password_hash, google_id, google_access_token, google_refresh_token,
                            google_token_expires_at, google_scopes,
                            totp_secret, totp_enabled, phone_number, phone_verified,
                            mfa_enabled, mfa_methods,
                            last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         ON CONFLICT (id) DO UPDATE SET
             github_id = EXCLUDED.github_id,
             login = EXCLUDED.login,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             email = EXCLUDED.email,
             role = EXCLUDED.role,
             password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
             google_id = COALESCE(EXCLUDED.google_id, users.google_id),
             google_access_token = COALESCE(EXCLUDED.google_access_token, users.google_access_token),
             google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, users.google_refresh_token),
             google_token_expires_at = COALESCE(EXCLUDED.google_token_expires_at, users.google_token_expires_at),
             google_scopes = COALESCE(EXCLUDED.google_scopes, users.google_scopes),
             totp_secret = COALESCE(EXCLUDED.totp_secret, users.totp_secret),
             totp_enabled = EXCLUDED.totp_enabled,
             phone_number = COALESCE(EXCLUDED.phone_number, users.phone_number),
             phone_verified = EXCLUDED.phone_verified,
             mfa_enabled = EXCLUDED.mfa_enabled,
             mfa_methods = EXCLUDED.mfa_methods,
             last_login_at = COALESCE(EXCLUDED.last_login_at, users.last_login_at),
             updated_at = EXCLUDED.updated_at",
    )
    .bind(user.id)
    .bind(user.github_id)
    .bind(&user.login)
    .bind(&user.display_name)
    .bind(&user.avatar_url)
    .bind(&user.email)
    .bind(&user.role)
    .bind(&user.password_hash)
    .bind(&user.google_id)
    .bind(&user.google_access_token)
    .bind(&user.google_refresh_token)
    .bind(user.google_token_expires_at)
    .bind(&user.google_scopes)
    .bind(&user.totp_secret)
    .bind(user.totp_enabled)
    .bind(&user.phone_number)
    .bind(user.phone_verified)
    .bind(user.mfa_enabled)
    .bind(&user.mfa_methods)
    .bind(user.last_login_at)
    .bind(user.created_at)
    .bind(user.updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_user(pool: &PgPool, user_id: Uuid) -> Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(user)
}

pub async fn get_user_by_github_id(pool: &PgPool, github_id: i64) -> Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE github_id = $1")
        .bind(github_id)
        .fetch_optional(pool)
        .await?;
    Ok(user)
}

pub async fn get_user_by_google_id(pool: &PgPool, google_id: &str) -> Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE google_id = $1")
        .bind(google_id)
        .fetch_optional(pool)
        .await?;
    Ok(user)
}

pub async fn get_user_by_email(pool: &PgPool, email: &str) -> Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(pool)
        .await?;
    Ok(user)
}

pub async fn count_users(pool: &PgPool) -> Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

// ── Refresh Sessions ────────────────────────────────

pub async fn create_refresh_session(
    pool: &PgPool,
    user_id: Uuid,
    refresh_token: &str,
    expires_at: chrono::DateTime<Utc>,
) -> Result<()> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO refresh_sessions (id, user_id, refresh_token, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(refresh_token)
    .bind(expires_at)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn find_refresh_session(pool: &PgPool, refresh_token: &str) -> Result<Option<RefreshSession>> {
    let session = sqlx::query_as::<_, RefreshSession>(
        "SELECT * FROM refresh_sessions WHERE refresh_token = $1",
    )
    .bind(refresh_token)
    .fetch_optional(pool)
    .await?;
    Ok(session)
}

pub async fn rotate_refresh_token(
    pool: &PgPool,
    session_id: Uuid,
    new_token: &str,
    new_expires_at: chrono::DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE refresh_sessions SET refresh_token = $1, expires_at = $2 WHERE id = $3",
    )
    .bind(new_token)
    .bind(new_expires_at)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_refresh_session_by_token(pool: &PgPool, refresh_token: &str) -> Result<()> {
    sqlx::query("DELETE FROM refresh_sessions WHERE refresh_token = $1")
        .bind(refresh_token)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Verification Codes ─────────────────────────────

pub async fn create_verification_code(
    pool: &PgPool,
    user_id: Uuid,
    code: &str,
    method: &str,
    expires_at: chrono::DateTime<Utc>,
) -> Result<()> {
    let id = Uuid::new_v4();
    // 同一ユーザー・メソッドの未使用コードを無効化
    sqlx::query(
        "UPDATE verification_codes SET used = TRUE WHERE user_id = $1 AND method = $2 AND NOT used",
    )
    .bind(user_id)
    .bind(method)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO verification_codes (id, user_id, code, method, expires_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(code)
    .bind(method)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn verify_code(
    pool: &PgPool,
    user_id: Uuid,
    code: &str,
    method: &str,
) -> Result<bool> {
    let now = Utc::now();
    let result = sqlx::query(
        "UPDATE verification_codes
         SET used = TRUE
         WHERE user_id = $1 AND code = $2 AND method = $3 AND NOT used AND expires_at > $4",
    )
    .bind(user_id)
    .bind(code)
    .bind(method)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn cleanup_expired_codes(pool: &PgPool) -> Result<u64> {
    let now = Utc::now();
    let result = sqlx::query("DELETE FROM verification_codes WHERE expires_at < $1 OR used = TRUE")
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// MFA フィールドのみ更新
pub async fn update_user_mfa(
    pool: &PgPool,
    user_id: Uuid,
    totp_secret: Option<&str>,
    totp_enabled: bool,
    phone_number: Option<&str>,
    phone_verified: bool,
    mfa_enabled: bool,
    mfa_methods: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE users SET
            totp_secret = $2,
            totp_enabled = $3,
            phone_number = $4,
            phone_verified = $5,
            mfa_enabled = $6,
            mfa_methods = $7,
            updated_at = $8
         WHERE id = $1",
    )
    .bind(user_id)
    .bind(totp_secret)
    .bind(totp_enabled)
    .bind(phone_number)
    .bind(phone_verified)
    .bind(mfa_enabled)
    .bind(mfa_methods)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// GitHub ID をユーザーにリンク (フェデレーション)
pub async fn link_github_to_user(
    pool: &PgPool,
    user_id: Uuid,
    github_id: i64,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query("UPDATE users SET github_id = $2, updated_at = $3 WHERE id = $1")
        .bind(user_id)
        .bind(github_id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

/// Google ID をユーザーにリンク (フェデレーション)
pub async fn link_google_to_user(
    pool: &PgPool,
    user_id: Uuid,
    google_id: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    token_expires_at: i64,
    scopes: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE users SET
            google_id = $2,
            google_access_token = $3,
            google_refresh_token = COALESCE($4, google_refresh_token),
            google_token_expires_at = $5,
            google_scopes = $6,
            updated_at = $7
         WHERE id = $1",
    )
    .bind(user_id)
    .bind(google_id)
    .bind(access_token)
    .bind(refresh_token)
    .bind(token_expires_at)
    .bind(scopes)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// GitHub ID のリンク解除
pub async fn unlink_github(pool: &PgPool, user_id: Uuid) -> Result<()> {
    let now = Utc::now();
    sqlx::query("UPDATE users SET github_id = NULL, updated_at = $2 WHERE id = $1")
        .bind(user_id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

/// Google ID のリンク解除
pub async fn unlink_google(pool: &PgPool, user_id: Uuid) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE users SET google_id = NULL, google_access_token = NULL,
            google_refresh_token = NULL, google_token_expires_at = NULL,
            google_scopes = NULL, updated_at = $2
         WHERE id = $1",
    )
    .bind(user_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Project ─────────────────────────────────────────

pub async fn upsert_project(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
    name: &str,
    data: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO projects (id, user_id, name, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             data = EXCLUDED.data,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(name)
    .bind(data)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_project(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<Option<Project>> {
    let project = sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(project)
}

pub async fn list_projects(pool: &PgPool, user_id: Uuid) -> Result<Vec<ProjectSummary>> {
    let summaries = sqlx::query_as::<_, ProjectSummary>(
        "SELECT id, name, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(summaries)
}

pub async fn delete_project(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<()> {
    let result = sqlx::query("DELETE FROM projects WHERE id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Project not found".into()));
    }
    Ok(())
}

// ── Project Settings ────────────────────────────────

pub async fn put_setting(
    pool: &PgPool,
    project_id: Uuid,
    key: &str,
    value: &str,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO project_settings (project_id, setting_key, value, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, setting_key) DO UPDATE SET
             value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(project_id)
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_setting(
    pool: &PgPool,
    project_id: Uuid,
    key: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM project_settings WHERE project_id = $1 AND setting_key = $2",
    )
    .bind(project_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.0))
}

pub async fn get_all_settings(
    pool: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectSetting>> {
    let settings = sqlx::query_as::<_, ProjectSetting>(
        "SELECT * FROM project_settings WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(settings)
}

pub async fn delete_setting(
    pool: &PgPool,
    project_id: Uuid,
    key: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM project_settings WHERE project_id = $1 AND setting_key = $2")
        .bind(project_id)
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}
