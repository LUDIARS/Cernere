use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, post, put};
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
use crate::models::{ProjectSummary, ServiceResponse, UserResponse};
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
async fn auth_get(
    ws: Option<WebSocketUpgrade>,
    State(state): State<AppState>,
    Query(query): Query<ws::WsConnectQuery>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Response> {
    // Upgrade: websocket ヘッダーがある場合は WebSocket にアップグレード
    if let Some(upgrade) = ws {
        return ws::ws_upgrade_from(state, query, upgrade)
            .await
            .map(IntoResponse::into_response);
    }

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
        }))
        .into_response());
    }

    // セッション確認: JWT Bearer
    if let Ok(user) = auth::extract_user_from_jwt(&state, &headers).await {
        let user_state = state.redis.get_user_state(&user.id).await?;

        return Ok(Json(serde_json::json!({
            "authenticated": true,
            "user": UserResponse::from(user),
            "userState": user_state.as_ref().map(|s| &s.state),
            "config": config,
        }))
        .into_response());
    }

    // 認証なし → ログイン/サインアップ情報を返す
    Ok(Json(serde_json::json!({
        "authenticated": false,
        "config": config,
    }))
    .into_response())
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

// ── Service Management (admin only) ─────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterServiceRequest {
    code: String,
    name: String,
    endpoint_url: String,
    scopes: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterServiceResponse {
    service: ServiceResponse,
    service_secret: String,
}

async fn api_register_service(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RegisterServiceRequest>,
) -> Result<Json<RegisterServiceResponse>> {
    let user = auth::extract_user_from_jwt(&state, &headers).await?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("System admin required".into()));
    }

    let id = uuid::Uuid::new_v4();
    let secret = uuid::Uuid::new_v4().to_string();
    let hash = bcrypt::hash(&secret, 12)
        .map_err(|e| AppError::Internal(format!("Hash failed: {}", e)))?;
    let scopes = req.scopes.unwrap_or(serde_json::json!([]));

    let svc = db::create_service(&state.db, id, &req.code, &req.name, &hash, &req.endpoint_url, &scopes).await?;

    Ok(Json(RegisterServiceResponse {
        service: ServiceResponse {
            id: svc.id.to_string(),
            code: svc.code.clone(),
            name: svc.name,
            endpoint_url: svc.endpoint_url,
            scopes: svc.scopes,
            is_active: svc.is_active,
            is_connected: state.service_connections.is_connected(&svc.code),
            last_connected_at: None,
        },
        service_secret: secret,
    }))
}

async fn api_list_services(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<ServiceResponse>>> {
    let _user = auth::extract_user_from_jwt(&state, &headers).await?;
    let services = db::list_services(&state.db).await?;
    let result: Vec<ServiceResponse> = services
        .into_iter()
        .map(|s| ServiceResponse {
            id: s.id.to_string(),
            code: s.code.clone(),
            name: s.name,
            endpoint_url: s.endpoint_url,
            scopes: s.scopes,
            is_active: s.is_active,
            is_connected: state.service_connections.is_connected(&s.code),
            last_connected_at: s.last_connected_at.map(|t| t.to_rfc3339()),
        })
        .collect();
    Ok(Json(result))
}

async fn api_delete_service(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(service_id): Path<uuid::Uuid>,
) -> Result<Json<()>> {
    let user = auth::extract_user_from_jwt(&state, &headers).await?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("System admin required".into()));
    }
    db::delete_service(&state.db, service_id).await?;
    Ok(Json(()))
}

// ── Router ──────────────────────────────────────────

pub fn router(state: AppState) -> Router {
    Router::new()
        // 統合認証エンドポイント (共通 /auth)
        // GET -> 認証状態取得, WS -> セッション接続
        .route("/auth", get(auth_get))
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
        // OAuth 認可コード交換
        .route("/api/auth/exchange", post(auth::exchange_auth_code))
        // GitHub OAuth (Cookie-based)
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
        // ツールクライアント管理
        .route("/api/auth/tools", post(auth::create_tool_client).get(auth::list_tool_clients))
        .route("/api/auth/tools/{tool_id}", delete(auth::delete_tool_client))
        // ユーザープロファイル
        .route("/api/profile", get(auth::get_my_profile).put(auth::update_my_profile))
        .route("/api/profile/privacy", put(auth::update_profile_privacy))
        .route("/api/profile/optouts", get(auth::list_optouts).post(auth::create_optout).delete(auth::delete_optout))
        .route("/api/users/{user_id}/profile", get(auth::get_public_profile))
        // サービス管理 (admin)
        .route("/api/services", post(api_register_service).get(api_list_services))
        .route("/api/services/{service_id}", delete(api_delete_service))
        // サービス WebSocket 接続 (3点方式認証)
        .route("/ws/service", get(ws::service_ws_upgrade))
        // Projects (Cookie ベース)
        .route("/api/projects", get(api_list_projects).post(api_save_project))
        .route("/api/projects/{project_id}", get(api_load_project).delete(api_delete_project))
        // Settings (Cookie ベース)
        .route("/api/settings", get(api_get_setting).post(api_put_setting).delete(api_delete_setting))
        .route("/api/settings/all", get(api_get_all_settings))
        .with_state(state)
}
