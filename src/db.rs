use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::{
    Organization, OrganizationMember, OrganizationMemberWithUser, Project, ProjectDefinition,
    ProjectSetting, ProjectSummary, RefreshSession, ToolClient, User, UserProfile,
    VerificationCode,
};

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

// ── Organization ───────────────────────────────────

pub async fn create_organization(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    slug: &str,
    description: &str,
    created_by: Uuid,
) -> Result<Organization> {
    let now = Utc::now();
    let org = sqlx::query_as::<_, Organization>(
        "INSERT INTO organizations (id, name, slug, description, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *",
    )
    .bind(id)
    .bind(name)
    .bind(slug)
    .bind(description)
    .bind(created_by)
    .bind(now)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(org)
}

pub async fn get_organization(pool: &PgPool, org_id: Uuid) -> Result<Option<Organization>> {
    let org = sqlx::query_as::<_, Organization>("SELECT * FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_optional(pool)
        .await?;
    Ok(org)
}

pub async fn get_organization_by_slug(pool: &PgPool, slug: &str) -> Result<Option<Organization>> {
    let org = sqlx::query_as::<_, Organization>("SELECT * FROM organizations WHERE slug = $1")
        .bind(slug)
        .fetch_optional(pool)
        .await?;
    Ok(org)
}

pub async fn update_organization(
    pool: &PgPool,
    org_id: Uuid,
    name: &str,
    description: &str,
) -> Result<()> {
    let now = Utc::now();
    let result = sqlx::query(
        "UPDATE organizations SET name = $1, description = $2, updated_at = $3 WHERE id = $4",
    )
    .bind(name)
    .bind(description)
    .bind(now)
    .bind(org_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Organization not found".into()));
    }
    Ok(())
}

pub async fn delete_organization(pool: &PgPool, org_id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(org_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Organization not found".into()));
    }
    Ok(())
}

/// ユーザーが所属する組織一覧を取得
pub async fn list_user_organizations(pool: &PgPool, user_id: Uuid) -> Result<Vec<Organization>> {
    let orgs = sqlx::query_as::<_, Organization>(
        "SELECT o.* FROM organizations o
         INNER JOIN organization_members om ON o.id = om.organization_id
         WHERE om.user_id = $1
         ORDER BY o.name",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(orgs)
}

/// 2人のユーザーが同じ組織に所属しているか確認
pub async fn share_organization(pool: &PgPool, user_a: Uuid, user_b: Uuid) -> Result<bool> {
    let row = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
             SELECT 1 FROM organization_members a
             INNER JOIN organization_members b ON a.organization_id = b.organization_id
             WHERE a.user_id = $1 AND b.user_id = $2
         )",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

// ── Organization Members ───────────────────────────

pub async fn add_organization_member(
    pool: &PgPool,
    org_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_organization_member(
    pool: &PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<()> {
    let result = sqlx::query(
        "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Member not found".into()));
    }
    Ok(())
}

pub async fn get_organization_member(
    pool: &PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<Option<OrganizationMember>> {
    let member = sqlx::query_as::<_, OrganizationMember>(
        "SELECT * FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(member)
}

/// 組織メンバー一覧（ユーザー情報付き）
pub async fn list_organization_members(
    pool: &PgPool,
    org_id: Uuid,
) -> Result<Vec<OrganizationMemberWithUser>> {
    let members = sqlx::query_as::<_, OrganizationMemberWithUser>(
        "SELECT om.organization_id, om.user_id, om.role, om.joined_at,
                u.login, u.display_name, u.avatar_url, u.email, u.last_login_at
         FROM organization_members om
         INNER JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = $1
         ORDER BY om.joined_at",
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    Ok(members)
}

// ── Project Definitions ────────────────────────────

pub async fn create_project_definition(
    pool: &PgPool,
    id: Uuid,
    code: &str,
    name: &str,
    data_schema: &serde_json::Value,
    commands: &serde_json::Value,
    plugin_repository: &str,
) -> Result<ProjectDefinition> {
    let now = Utc::now();
    let pd = sqlx::query_as::<_, ProjectDefinition>(
        "INSERT INTO project_definitions (id, code, name, data_schema, commands, plugin_repository, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *",
    )
    .bind(id)
    .bind(code)
    .bind(name)
    .bind(data_schema)
    .bind(commands)
    .bind(plugin_repository)
    .bind(now)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(pd)
}

pub async fn get_project_definition(
    pool: &PgPool,
    pd_id: Uuid,
) -> Result<Option<ProjectDefinition>> {
    let pd = sqlx::query_as::<_, ProjectDefinition>(
        "SELECT * FROM project_definitions WHERE id = $1",
    )
    .bind(pd_id)
    .fetch_optional(pool)
    .await?;
    Ok(pd)
}

pub async fn get_project_definition_by_code(
    pool: &PgPool,
    code: &str,
) -> Result<Option<ProjectDefinition>> {
    let pd = sqlx::query_as::<_, ProjectDefinition>(
        "SELECT * FROM project_definitions WHERE code = $1",
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(pd)
}

pub async fn update_project_definition(
    pool: &PgPool,
    pd_id: Uuid,
    name: &str,
    data_schema: &serde_json::Value,
    commands: &serde_json::Value,
    plugin_repository: &str,
) -> Result<()> {
    let now = Utc::now();
    let result = sqlx::query(
        "UPDATE project_definitions
         SET name = $1, data_schema = $2, commands = $3, plugin_repository = $4, updated_at = $5
         WHERE id = $6",
    )
    .bind(name)
    .bind(data_schema)
    .bind(commands)
    .bind(plugin_repository)
    .bind(now)
    .bind(pd_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Project definition not found".into()));
    }
    Ok(())
}

pub async fn delete_project_definition(pool: &PgPool, pd_id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM project_definitions WHERE id = $1")
        .bind(pd_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Project definition not found".into()));
    }
    Ok(())
}

pub async fn list_project_definitions(pool: &PgPool) -> Result<Vec<ProjectDefinition>> {
    let pds = sqlx::query_as::<_, ProjectDefinition>(
        "SELECT * FROM project_definitions ORDER BY code",
    )
    .fetch_all(pool)
    .await?;
    Ok(pds)
}

// ── Organization Projects (組織のプロジェクト有効化) ─

pub async fn enable_organization_project(
    pool: &PgPool,
    org_id: Uuid,
    pd_id: Uuid,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO organization_projects (organization_id, project_definition_id)
         VALUES ($1, $2)
         ON CONFLICT (organization_id, project_definition_id) DO NOTHING",
    )
    .bind(org_id)
    .bind(pd_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn disable_organization_project(
    pool: &PgPool,
    org_id: Uuid,
    pd_id: Uuid,
) -> Result<()> {
    sqlx::query(
        "DELETE FROM organization_projects
         WHERE organization_id = $1 AND project_definition_id = $2",
    )
    .bind(org_id)
    .bind(pd_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 組織が有効にしているプロジェクト定義一覧
pub async fn list_organization_projects(
    pool: &PgPool,
    org_id: Uuid,
) -> Result<Vec<ProjectDefinition>> {
    let pds = sqlx::query_as::<_, ProjectDefinition>(
        "SELECT pd.* FROM project_definitions pd
         INNER JOIN organization_projects op ON pd.id = op.project_definition_id
         WHERE op.organization_id = $1
         ORDER BY pd.code",
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    Ok(pds)
}

// ── Tool Clients ──────────────────────────────────

pub async fn create_tool_client(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    client_id: &str,
    client_secret_hash: &str,
    owner_user_id: Uuid,
    scopes: &serde_json::Value,
) -> Result<ToolClient> {
    let tc = sqlx::query_as::<_, ToolClient>(
        "INSERT INTO tool_clients (id, name, client_id, client_secret_hash, owner_user_id, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *",
    )
    .bind(id)
    .bind(name)
    .bind(client_id)
    .bind(client_secret_hash)
    .bind(owner_user_id)
    .bind(scopes)
    .fetch_one(pool)
    .await?;
    Ok(tc)
}

pub async fn get_tool_client_by_client_id(
    pool: &PgPool,
    client_id: &str,
) -> Result<Option<ToolClient>> {
    let tc = sqlx::query_as::<_, ToolClient>(
        "SELECT * FROM tool_clients WHERE client_id = $1",
    )
    .bind(client_id)
    .fetch_optional(pool)
    .await?;
    Ok(tc)
}

pub async fn list_tool_clients_by_owner(
    pool: &PgPool,
    owner_user_id: Uuid,
) -> Result<Vec<ToolClient>> {
    let clients = sqlx::query_as::<_, ToolClient>(
        "SELECT * FROM tool_clients WHERE owner_user_id = $1 ORDER BY created_at DESC",
    )
    .bind(owner_user_id)
    .fetch_all(pool)
    .await?;
    Ok(clients)
}

pub async fn delete_tool_client(
    pool: &PgPool,
    id: Uuid,
    owner_user_id: Uuid,
) -> Result<()> {
    let result = sqlx::query(
        "DELETE FROM tool_clients WHERE id = $1 AND owner_user_id = $2",
    )
    .bind(id)
    .bind(owner_user_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Tool client not found".into()));
    }
    Ok(())
}

pub async fn update_tool_client_last_used(pool: &PgPool, id: Uuid) -> Result<()> {
    let now = Utc::now();
    sqlx::query("UPDATE tool_clients SET last_used_at = $2, updated_at = $2 WHERE id = $1")
        .bind(id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

// ── User Profiles ─────────────────────────────────

pub async fn upsert_user_profile(
    pool: &PgPool,
    user_id: Uuid,
    role_title: &str,
    bio: &str,
    expertise: &serde_json::Value,
    hobbies: &serde_json::Value,
    extra: &serde_json::Value,
    privacy: &serde_json::Value,
) -> Result<UserProfile> {
    let now = Utc::now();
    let profile = sqlx::query_as::<_, UserProfile>(
        "INSERT INTO user_profiles (user_id, role_title, bio, expertise, hobbies, extra, privacy, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (user_id) DO UPDATE SET
             role_title = EXCLUDED.role_title,
             bio = EXCLUDED.bio,
             expertise = EXCLUDED.expertise,
             hobbies = EXCLUDED.hobbies,
             extra = EXCLUDED.extra,
             privacy = EXCLUDED.privacy,
             updated_at = EXCLUDED.updated_at
         RETURNING *",
    )
    .bind(user_id)
    .bind(role_title)
    .bind(bio)
    .bind(expertise)
    .bind(hobbies)
    .bind(extra)
    .bind(privacy)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(profile)
}

pub async fn get_user_profile(pool: &PgPool, user_id: Uuid) -> Result<Option<UserProfile>> {
    let profile = sqlx::query_as::<_, UserProfile>(
        "SELECT * FROM user_profiles WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(profile)
}

pub async fn update_profile_privacy(
    pool: &PgPool,
    user_id: Uuid,
    privacy: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE user_profiles SET privacy = $2, updated_at = $3 WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(privacy)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}
