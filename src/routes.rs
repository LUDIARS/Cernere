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
use crate::env_auth;
use crate::error::{AppError, Result};
use crate::mfa;
use crate::models::{ProjectSummary, UserResponse};
use crate::session_state::{UserFullState, UserState};
use crate::ws;

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

// ── 統合 /auth エンドポイント ───────────────────────

/// GET /auth — 環境の認証設定と現在のセッション状態を返す
///
/// セッション情報がない場合 → ログイン/サインアップ画面遷移用情報
/// セッションがある場合 → ユーザのステートを確認して返す
async fn auth_negotiate(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let config = env_auth::build_auth_config(&state);

    // セッション確認: Cookie ベース
    if let Ok(session) = auth::extract_session(&state, &jar).await {
        let user_state = state.redis.get_user_state(&session.user_id).await?;
        let user = db::get_user(&state.db, session.user_id).await?;

        return Ok(Json(serde_json::json!({
            "authenticated": true,
            "sessionId": session.id,
            "user": user.map(UserResponse::from),
            "userState": user_state.as_ref().map(|s| &s.state),
            "config": config,
        })));
    }

    // セッション確認: JWT Bearer
    if let Ok(user) = auth::extract_user_from_jwt(&state, &headers).await {
        let user_state = state.redis.get_user_state(&user.id).await?;

        return Ok(Json(serde_json::json!({
            "authenticated": true,
            "user": UserResponse::from(user),
            "userState": user_state.as_ref().map(|s| &s.state),
            "config": config,
        })));
    }

    // 認証なし → ログイン/サインアップ情報を返す
    Ok(Json(serde_json::json!({
        "authenticated": false,
        "config": config,
    })))
}

/// GET /auth/state — ユーザステートの詳細取得
async fn auth_state(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>> {
    // Cookie or JWT で認証
    let user_id = if let Ok(session) = auth::extract_session(&state, &jar).await {
        session.user_id
    } else if let Ok(user) = auth::extract_user_from_jwt(&state, &headers).await {
        user.id
    } else {
        return Ok(Json(serde_json::json!({
            "state": UserState::None,
        })));
    };

    let user_state = state
        .redis
        .get_user_state(&user_id)
        .await?
        .unwrap_or(UserFullState {
            user_id,
            session_id: String::new(),
            state: UserState::None,
            modules: Vec::new(),
            last_ping_at: 0,
        });

    Ok(Json(serde_json::json!({
        "state": user_state.state,
        "modules": user_state.modules,
        "lastPingAt": user_state.last_ping_at,
    })))
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
        // 統合認証エンドポイント (共通 /auth)
        .route("/auth", get(auth_negotiate))
        .route("/auth/state", get(auth_state))
        // JWT Auth (password / Google OAuth)
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/auth/logout", post(auth::logout_jwt))
        .route("/api/auth/me", get(auth::get_me_jwt))
        // Google OAuth
        .route("/auth/google/login", get(auth::google_login))
        .route("/auth/google/callback", get(auth::google_callback))
        // GitHub OAuth (Cookie-based, Ars BFF)
        .route("/auth/github/login", get(auth::github_login))
        .route("/auth/github/callback", get(auth::github_callback))
        .route("/auth/me", get(auth::get_me))
        .route("/auth/logout", post(auth::logout))
        // MFA
        .route("/api/auth/mfa/status", get(mfa::mfa_status))
        .route("/api/auth/mfa/totp/setup", post(mfa::totp_setup))
        .route("/api/auth/mfa/totp/enable", post(mfa::totp_enable))
        .route("/api/auth/mfa/totp/disable", post(mfa::totp_disable))
        .route("/api/auth/mfa/sms/setup", post(mfa::sms_setup))
        .route("/api/auth/mfa/sms/verify-phone", post(mfa::sms_verify_phone))
        .route("/api/auth/mfa/sms/enable", post(mfa::sms_enable))
        .route("/api/auth/mfa/sms/disable", post(mfa::sms_disable))
        .route("/api/auth/mfa/email/enable", post(mfa::email_mfa_enable))
        .route("/api/auth/mfa/email/disable", post(mfa::email_mfa_disable))
        .route("/api/auth/mfa/send-code", post(mfa::mfa_send_code))
        .route("/api/auth/mfa/verify", post(mfa::mfa_verify))
        // フェデレーション (アカウントリンク)
        .route("/auth/link/github", get(auth::link_github_login))
        .route("/auth/link/google", get(auth::link_google_login))
        .route("/api/auth/unlink", post(auth::unlink_provider))
        // WebSocket セッション接続
        .route("/ws", get(ws::ws_upgrade))
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
