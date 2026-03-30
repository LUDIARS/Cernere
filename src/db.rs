use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::{Project, ProjectSetting, ProjectSummary, User};

// ── User ────────────────────────────────────────────

pub async fn upsert_user(pool: &PgPool, user: &User) -> Result<()> {
    sqlx::query(
        "INSERT INTO users (id, github_id, login, display_name, avatar_url, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
             login = EXCLUDED.login,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             email = EXCLUDED.email,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(user.id)
    .bind(user.github_id)
    .bind(&user.login)
    .bind(&user.display_name)
    .bind(&user.avatar_url)
    .bind(&user.email)
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
