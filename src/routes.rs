use axum::extract::{Path, Query, State};
use axum::response::Json;
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
use crate::models::{
    MemberResponse, OrganizationResponse, ProjectDefinitionResponse, ProjectSummary, UserResponse,
};
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

/// GET /api/users/:user_id — 同じ組織に属するユーザーの情報のみ取得可能
async fn api_get_user(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(user_id): Path<Uuid>,
) -> Result<Json<UserResponse>> {
    let caller = auth_user(&state, &jar, &headers).await?;

    // 自分自身の場合は OK
    if caller.id != user_id {
        // 同じ組織に属しているかチェック
        let caller_orgs = db::list_user_organizations(&state.db, caller.id).await?;
        let target_orgs = db::list_user_organizations(&state.db, user_id).await?;
        let caller_org_ids: std::collections::HashSet<Uuid> =
            caller_orgs.iter().map(|o| o.id).collect();
        let shares_org = target_orgs.iter().any(|o| caller_org_ids.contains(&o.id));
        if !shares_org {
            return Err(AppError::Forbidden(
                "User is not in any of your organizations".into(),
            ));
        }
    }

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

// ── Organization routes ────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrganizationRequest {
    name: String,
    slug: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateOrganizationRequest {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMemberRequest {
    user_id: Uuid,
    #[serde(default = "default_member_role")]
    role: String,
}

fn default_member_role() -> String {
    "member".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMemberRoleRequest {
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectDefinitionRequest {
    code: String,
    name: String,
    #[serde(default = "default_json_object")]
    data_schema: serde_json::Value,
    #[serde(default = "default_json_array")]
    commands: serde_json::Value,
    #[serde(default)]
    plugin_repository: String,
}

fn default_json_object() -> serde_json::Value {
    serde_json::json!({})
}
fn default_json_array() -> serde_json::Value {
    serde_json::json!([])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProjectDefinitionRequest {
    name: String,
    #[serde(default = "default_json_object")]
    data_schema: serde_json::Value,
    #[serde(default = "default_json_array")]
    commands: serde_json::Value,
    #[serde(default)]
    plugin_repository: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgProjectRequest {
    project_definition_id: Uuid,
}

/// 組織メンバーかどうかを検証し、メンバー情報を返す
async fn require_org_member(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<crate::models::OrganizationMember> {
    db::get_organization_member(&state.db, org_id, user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))
}

/// 組織の owner/admin かどうかを検証
async fn require_org_admin(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<crate::models::OrganizationMember> {
    let member = require_org_member(state, org_id, user_id).await?;
    if member.role != "owner" && member.role != "admin" {
        return Err(AppError::Forbidden(
            "Admin or owner role required".into(),
        ));
    }
    Ok(member)
}

/// POST /api/organizations — 組織作成
async fn api_create_organization(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateOrganizationRequest>,
) -> Result<(axum::http::StatusCode, Json<OrganizationResponse>)> {
    let user = auth_user(&state, &jar, &headers).await?;

    if req.slug.is_empty() || req.name.is_empty() {
        return Err(AppError::BadRequest("Name and slug are required".into()));
    }

    if db::get_organization_by_slug(&state.db, &req.slug)
        .await?
        .is_some()
    {
        return Err(AppError::BadRequest("Slug already taken".into()));
    }

    let org_id = Uuid::new_v4();
    let org =
        db::create_organization(&state.db, org_id, &req.name, &req.slug, &req.description, user.id)
            .await?;

    // 作成者を owner として追加
    db::add_organization_member(&state.db, org_id, user.id, "owner").await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(OrganizationResponse::from(org)),
    ))
}

/// GET /api/organizations — 自分が所属する組織一覧
async fn api_list_organizations(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<OrganizationResponse>>> {
    let user = auth_user(&state, &jar, &headers).await?;
    let orgs = db::list_user_organizations(&state.db, user.id).await?;
    Ok(Json(orgs.into_iter().map(OrganizationResponse::from).collect()))
}

/// GET /api/organizations/:org_id — 組織詳細
async fn api_get_organization(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<OrganizationResponse>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_member(&state, org_id, user.id).await?;
    let org = db::get_organization(&state.db, org_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Organization not found".into()))?;
    Ok(Json(OrganizationResponse::from(org)))
}

/// PUT /api/organizations/:org_id — 組織更新
async fn api_update_organization(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
    Json(req): Json<UpdateOrganizationRequest>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_admin(&state, org_id, user.id).await?;
    db::update_organization(&state.db, org_id, &req.name, &req.description).await?;
    Ok(Json(()))
}

/// DELETE /api/organizations/:org_id — 組織削除
async fn api_delete_organization(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    let member = require_org_member(&state, org_id, user.id).await?;
    if member.role != "owner" {
        return Err(AppError::Forbidden("Only the owner can delete an organization".into()));
    }
    db::delete_organization(&state.db, org_id).await?;
    Ok(Json(()))
}

/// GET /api/organizations/:org_id/members — メンバー一覧
async fn api_list_members(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<MemberResponse>>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_member(&state, org_id, user.id).await?;
    let members = db::list_organization_members(&state.db, org_id).await?;
    Ok(Json(members.into_iter().map(MemberResponse::from).collect()))
}

/// POST /api/organizations/:org_id/members — メンバー追加
async fn api_add_member(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
    Json(req): Json<AddMemberRequest>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_admin(&state, org_id, user.id).await?;

    // owner ロールはこの API では設定不可
    if req.role == "owner" {
        return Err(AppError::BadRequest("Cannot assign owner role via this endpoint".into()));
    }

    db::add_organization_member(&state.db, org_id, req.user_id, &req.role).await?;
    Ok(Json(()))
}

/// PUT /api/organizations/:org_id/members/:user_id — メンバーロール更新
async fn api_update_member_role(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((org_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateMemberRoleRequest>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    let caller = require_org_member(&state, org_id, user.id).await?;

    if req.role == "owner" && caller.role != "owner" {
        return Err(AppError::Forbidden("Only the owner can transfer ownership".into()));
    }
    if caller.role != "owner" && caller.role != "admin" {
        return Err(AppError::Forbidden("Admin or owner role required".into()));
    }

    db::add_organization_member(&state.db, org_id, target_user_id, &req.role).await?;
    Ok(Json(()))
}

/// DELETE /api/organizations/:org_id/members/:user_id — メンバー削除
async fn api_remove_member(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((org_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    let caller = require_org_member(&state, org_id, user.id).await?;

    // 自分自身を脱退する場合は OK (ただし owner は不可)
    if user.id == target_user_id {
        if caller.role == "owner" {
            return Err(AppError::BadRequest(
                "Owner cannot leave the organization. Transfer ownership first.".into(),
            ));
        }
    } else {
        // 他人を削除するには admin 以上
        require_org_admin(&state, org_id, user.id).await?;
    }

    db::remove_organization_member(&state.db, org_id, target_user_id).await?;
    Ok(Json(()))
}

// ── Organization Projects routes ───────────────────

/// GET /api/organizations/:org_id/projects — 組織の有効プロジェクト一覧
async fn api_list_org_projects(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectDefinitionResponse>>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_member(&state, org_id, user.id).await?;
    let pds = db::list_organization_projects(&state.db, org_id).await?;
    Ok(Json(
        pds.into_iter()
            .map(ProjectDefinitionResponse::from)
            .collect(),
    ))
}

/// POST /api/organizations/:org_id/projects — プロジェクト有効化
async fn api_enable_org_project(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(org_id): Path<Uuid>,
    Json(req): Json<OrgProjectRequest>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_admin(&state, org_id, user.id).await?;
    // プロジェクト定義が存在するか確認
    db::get_project_definition(&state.db, req.project_definition_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
    db::enable_organization_project(&state.db, org_id, req.project_definition_id).await?;
    Ok(Json(()))
}

/// DELETE /api/organizations/:org_id/projects/:pd_id — プロジェクト無効化
async fn api_disable_org_project(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((org_id, pd_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    require_org_admin(&state, org_id, user.id).await?;
    db::disable_organization_project(&state.db, org_id, pd_id).await?;
    Ok(Json(()))
}

// ── Project Definition routes (admin only) ─────────

/// GET /api/project-definitions — 全プロジェクト定義一覧
async fn api_list_project_definitions(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<ProjectDefinitionResponse>>> {
    let _user = auth_user(&state, &jar, &headers).await?;
    let pds = db::list_project_definitions(&state.db).await?;
    Ok(Json(
        pds.into_iter()
            .map(ProjectDefinitionResponse::from)
            .collect(),
    ))
}

/// GET /api/project-definitions/:pd_id — プロジェクト定義詳細
async fn api_get_project_definition(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(pd_id): Path<Uuid>,
) -> Result<Json<ProjectDefinitionResponse>> {
    let _user = auth_user(&state, &jar, &headers).await?;
    let pd = db::get_project_definition(&state.db, pd_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
    Ok(Json(ProjectDefinitionResponse::from(pd)))
}

/// POST /api/project-definitions — プロジェクト定義作成 (admin のみ)
async fn api_create_project_definition(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateProjectDefinitionRequest>,
) -> Result<(axum::http::StatusCode, Json<ProjectDefinitionResponse>)> {
    let user = auth_user(&state, &jar, &headers).await?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("Admin role required".into()));
    }

    if db::get_project_definition_by_code(&state.db, &req.code)
        .await?
        .is_some()
    {
        return Err(AppError::BadRequest("Project code already exists".into()));
    }

    let pd = db::create_project_definition(
        &state.db,
        Uuid::new_v4(),
        &req.code,
        &req.name,
        &req.data_schema,
        &req.commands,
        &req.plugin_repository,
    )
    .await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(ProjectDefinitionResponse::from(pd)),
    ))
}

/// PUT /api/project-definitions/:pd_id — プロジェクト定義更新 (admin のみ)
async fn api_update_project_definition(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(pd_id): Path<Uuid>,
    Json(req): Json<UpdateProjectDefinitionRequest>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("Admin role required".into()));
    }
    db::update_project_definition(
        &state.db,
        pd_id,
        &req.name,
        &req.data_schema,
        &req.commands,
        &req.plugin_repository,
    )
    .await?;
    Ok(Json(()))
}

/// DELETE /api/project-definitions/:pd_id — プロジェクト定義削除 (admin のみ)
async fn api_delete_project_definition(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(pd_id): Path<Uuid>,
) -> Result<Json<()>> {
    let user = auth_user(&state, &jar, &headers).await?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("Admin role required".into()));
    }
    db::delete_project_definition(&state.db, pd_id).await?;
    Ok(Json(()))
}

/// Cookie or JWT でユーザーを認証するヘルパー
async fn auth_user(
    state: &AppState,
    jar: &CookieJar,
    headers: &axum::http::HeaderMap,
) -> Result<crate::models::User> {
    if let Ok(user) = auth::extract_user(state, jar).await {
        return Ok(user);
    }
    auth::extract_user_from_jwt(state, headers).await
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
        // Organizations
        .route("/api/organizations", get(api_list_organizations).post(api_create_organization))
        .route(
            "/api/organizations/{org_id}",
            get(api_get_organization).put(api_update_organization).delete(api_delete_organization),
        )
        // Organization Members
        .route(
            "/api/organizations/{org_id}/members",
            get(api_list_members).post(api_add_member),
        )
        .route(
            "/api/organizations/{org_id}/members/{user_id}",
            put(api_update_member_role).delete(api_remove_member),
        )
        // Organization Projects
        .route(
            "/api/organizations/{org_id}/projects",
            get(api_list_org_projects).post(api_enable_org_project),
        )
        .route(
            "/api/organizations/{org_id}/projects/{pd_id}",
            delete(api_disable_org_project),
        )
        // Project Definitions (admin)
        .route(
            "/api/project-definitions",
            get(api_list_project_definitions).post(api_create_project_definition),
        )
        .route(
            "/api/project-definitions/{pd_id}",
            get(api_get_project_definition)
                .put(api_update_project_definition)
                .delete(api_delete_project_definition),
        )
        .with_state(state)
}
