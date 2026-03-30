use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::auth;
use crate::db;
use crate::error::{AppError, Result};
use crate::models::{ProjectSummary, UserResponse};

// ── Request / Query types ───────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProjectRequest {
    project_id: Uuid,
    name: String,
    data: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadProjectQuery {
    project_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingRequest {
    project_id: Uuid,
    key: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingQuery {
    project_id: Uuid,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsQuery {
    project_id: Uuid,
}

// ── User routes ─────────────────────────────────────

async fn api_get_user(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<UserResponse>> {
    let user = db::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;
    Ok(Json(UserResponse::from(user)))
}

// ── Project routes ──────────────────────────────────

async fn api_save_project(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<SaveProjectRequest>,
) -> Result<Json<()>> {
    let user = auth::extract_user(&state, &jar).await?;
    db::upsert_project(&state.db, user.id, req.project_id, &req.name, &req.data).await?;
    Ok(Json(()))
}

async fn api_load_project(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<LoadProjectQuery>,
) -> Result<Json<serde_json::Value>> {
    let user = auth::extract_user(&state, &jar).await?;
    let project = db::load_project(&state.db, user.id, q.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))?;
    Ok(Json(project.data))
}

async fn api_list_projects(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<ProjectSummary>>> {
    let user = auth::extract_user(&state, &jar).await?;
    let summaries = db::list_projects(&state.db, user.id).await?;
    Ok(Json(summaries))
}

async fn api_delete_project(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(project_id): Path<Uuid>,
) -> Result<Json<()>> {
    let user = auth::extract_user(&state, &jar).await?;
    db::delete_project(&state.db, user.id, project_id).await?;
    Ok(Json(()))
}

// ── Setting routes ──────────────────────────────────

async fn api_put_setting(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<SettingRequest>,
) -> Result<Json<()>> {
    let user = auth::extract_user(&state, &jar).await?;
    // Verify project ownership
    db::load_project(&state.db, user.id, req.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))?;
    db::put_setting(&state.db, req.project_id, &req.key, &req.value).await?;
    Ok(Json(()))
}

async fn api_get_setting(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<SettingQuery>,
) -> Result<Json<Option<String>>> {
    let user = auth::extract_user(&state, &jar).await?;
    db::load_project(&state.db, user.id, q.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))?;
    let value = db::get_setting(&state.db, q.project_id, &q.key).await?;
    Ok(Json(value))
}

async fn api_get_all_settings(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<SettingsQuery>,
) -> Result<Json<HashMap<String, String>>> {
    let user = auth::extract_user(&state, &jar).await?;
    db::load_project(&state.db, user.id, q.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))?;
    let settings = db::get_all_settings(&state.db, q.project_id).await?;
    let map: HashMap<String, String> = settings
        .into_iter()
        .map(|s| (s.setting_key, s.value))
        .collect();
    Ok(Json(map))
}

async fn api_delete_setting(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<SettingQuery>,
) -> Result<Json<()>> {
    let user = auth::extract_user(&state, &jar).await?;
    db::load_project(&state.db, user.id, req.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))?;
    db::delete_setting(&state.db, req.project_id, &req.key).await?;
    Ok(Json(()))
}

// ── Router ──────────────────────────────────────────

pub fn router(state: AppState) -> Router {
    Router::new()
        // Auth
        .route("/auth/github/login", get(auth::github_login))
        .route("/auth/github/callback", get(auth::github_callback))
        .route("/auth/me", get(auth::get_me))
        .route("/auth/logout", post(auth::logout))
        // User
        .route("/api/users/{user_id}", get(api_get_user))
        // Projects
        .route("/api/projects", get(api_list_projects).post(api_save_project))
        .route("/api/projects/{project_id}", get(api_load_project).delete(api_delete_project))
        // Settings
        .route("/api/settings", get(api_get_setting).post(api_put_setting).delete(api_delete_setting))
        .route("/api/settings/all", get(api_get_all_settings))
        .with_state(state)
}
