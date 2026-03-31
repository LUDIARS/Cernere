//! WebSocket コマンドハンドラ
//!
//! WS セッション中の `module_request` メッセージを処理する。
//! 組織・メンバー・プロジェクト定義の全操作はここで行う。

use uuid::Uuid;

use crate::app_state::AppState;
use crate::db;
use crate::error::AppError;
use crate::models::{MemberResponse, OrganizationResponse, ProjectDefinitionResponse};

/// コマンド実行結果
pub type CmdResult = std::result::Result<serde_json::Value, AppError>;

/// module_request のディスパッチ
pub async fn dispatch(
    state: &AppState,
    user_id: &Uuid,
    module: &str,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match module {
        "organization" => handle_organization(state, user_id, action, payload).await,
        "member" => handle_member(state, user_id, action, payload).await,
        "project_definition" => handle_project_definition(state, user_id, action, payload).await,
        "org_project" => handle_org_project(state, user_id, action, payload).await,
        "user" => handle_user(state, user_id, action, payload).await,
        _ => Err(AppError::BadRequest(format!("Unknown module: {}", module))),
    }
}

// ── ヘルパー ───────────────────────────────────────

fn get_payload(payload: &Option<serde_json::Value>) -> Result<&serde_json::Value, AppError> {
    payload
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Payload is required".into()))
}

fn get_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, AppError> {
    v.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest(format!("Missing field: {}", key)))
}

fn get_uuid(v: &serde_json::Value, key: &str) -> Result<Uuid, AppError> {
    let s = get_str(v, key)?;
    s.parse::<Uuid>()
        .map_err(|_| AppError::BadRequest(format!("Invalid UUID: {}", key)))
}

/// 組織メンバーであることを検証
async fn require_member(
    state: &AppState,
    org_id: Uuid,
    user_id: &Uuid,
) -> Result<crate::models::OrganizationMember, AppError> {
    db::get_organization_member(&state.db, org_id, *user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))
}

/// 組織の admin/owner であることを検証
async fn require_admin(
    state: &AppState,
    org_id: Uuid,
    user_id: &Uuid,
) -> Result<crate::models::OrganizationMember, AppError> {
    let m = require_member(state, org_id, user_id).await?;
    if m.role != "owner" && m.role != "admin" {
        return Err(AppError::Forbidden("Admin or owner role required".into()));
    }
    Ok(m)
}

/// システム admin であることを検証
async fn require_system_admin(state: &AppState, user_id: &Uuid) -> Result<(), AppError> {
    let user = db::get_user(&state.db, *user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;
    if user.role != "admin" {
        return Err(AppError::Forbidden("System admin role required".into()));
    }
    Ok(())
}

// ── organization ───────────────────────────────────

async fn handle_organization(
    state: &AppState,
    user_id: &Uuid,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match action {
        // 自分が所属する組織一覧
        "list" => {
            let orgs = db::list_user_organizations(&state.db, *user_id).await?;
            let res: Vec<OrganizationResponse> =
                orgs.into_iter().map(OrganizationResponse::from).collect();
            Ok(serde_json::to_value(res).unwrap())
        }

        // 組織詳細 { organizationId }
        "get" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_member(state, org_id, user_id).await?;
            let org = db::get_organization(&state.db, org_id)
                .await?
                .ok_or_else(|| AppError::NotFound("Organization not found".into()))?;
            Ok(serde_json::to_value(OrganizationResponse::from(org)).unwrap())
        }

        // 組織作成 { name, slug, description? }
        "create" => {
            let p = get_payload(&payload)?;
            let name = get_str(p, "name")?;
            let slug = get_str(p, "slug")?;
            let description = p
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if name.is_empty() || slug.is_empty() {
                return Err(AppError::BadRequest("name and slug are required".into()));
            }

            if db::get_organization_by_slug(&state.db, slug)
                .await?
                .is_some()
            {
                return Err(AppError::BadRequest("Slug already taken".into()));
            }

            let org_id = Uuid::new_v4();
            let org =
                db::create_organization(&state.db, org_id, name, slug, description, *user_id)
                    .await?;
            // 作成者を owner として追加
            db::add_organization_member(&state.db, org_id, *user_id, "owner").await?;
            Ok(serde_json::to_value(OrganizationResponse::from(org)).unwrap())
        }

        // 組織更新 { organizationId, name, description? }
        "update" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_admin(state, org_id, user_id).await?;
            let name = get_str(p, "name")?;
            let description = p
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            db::update_organization(&state.db, org_id, name, description).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // 組織削除 { organizationId }  — owner のみ
        "delete" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            let m = require_member(state, org_id, user_id).await?;
            if m.role != "owner" {
                return Err(AppError::Forbidden(
                    "Only the owner can delete an organization".into(),
                ));
            }
            db::delete_organization(&state.db, org_id).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown organization action: {}",
            action
        ))),
    }
}

// ── member ─────────────────────────────────────────

async fn handle_member(
    state: &AppState,
    user_id: &Uuid,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match action {
        // メンバー一覧 { organizationId }
        "list" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_member(state, org_id, user_id).await?;
            let members = db::list_organization_members(&state.db, org_id).await?;
            let res: Vec<MemberResponse> = members.into_iter().map(MemberResponse::from).collect();
            Ok(serde_json::to_value(res).unwrap())
        }

        // メンバー追加 { organizationId, userId, role? }
        "add" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_admin(state, org_id, user_id).await?;
            let target_id = get_uuid(p, "userId")?;
            let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("member");

            if role == "owner" {
                return Err(AppError::BadRequest(
                    "Cannot assign owner role via this action".into(),
                ));
            }

            db::add_organization_member(&state.db, org_id, target_id, role).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // メンバーロール更新 { organizationId, userId, role }
        "update_role" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            let caller = require_member(state, org_id, user_id).await?;
            let target_id = get_uuid(p, "userId")?;
            let role = get_str(p, "role")?;

            if role == "owner" && caller.role != "owner" {
                return Err(AppError::Forbidden(
                    "Only the owner can transfer ownership".into(),
                ));
            }
            if caller.role != "owner" && caller.role != "admin" {
                return Err(AppError::Forbidden("Admin or owner role required".into()));
            }

            db::add_organization_member(&state.db, org_id, target_id, role).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // メンバー削除 { organizationId, userId }
        "remove" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            let caller = require_member(state, org_id, user_id).await?;
            let target_id = get_uuid(p, "userId")?;

            if *user_id == target_id {
                // 自分自身の脱退
                if caller.role == "owner" {
                    return Err(AppError::BadRequest(
                        "Owner cannot leave. Transfer ownership first.".into(),
                    ));
                }
            } else {
                // 他人を削除するには admin 以上
                require_admin(state, org_id, user_id).await?;
            }

            db::remove_organization_member(&state.db, org_id, target_id).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown member action: {}",
            action
        ))),
    }
}

// ── project_definition ─────────────────────────────

async fn handle_project_definition(
    state: &AppState,
    user_id: &Uuid,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match action {
        // 全プロジェクト定義一覧
        "list" => {
            let pds = db::list_project_definitions(&state.db).await?;
            let res: Vec<ProjectDefinitionResponse> =
                pds.into_iter().map(ProjectDefinitionResponse::from).collect();
            Ok(serde_json::to_value(res).unwrap())
        }

        // プロジェクト定義詳細 { id }
        "get" => {
            let p = get_payload(&payload)?;
            let pd_id = get_uuid(p, "id")?;
            let pd = db::get_project_definition(&state.db, pd_id)
                .await?
                .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
            Ok(serde_json::to_value(ProjectDefinitionResponse::from(pd)).unwrap())
        }

        // プロジェクト定義作成 — admin のみ
        // { code, name, dataSchema?, commands?, pluginRepository? }
        "create" => {
            require_system_admin(state, user_id).await?;
            let p = get_payload(&payload)?;
            let code = get_str(p, "code")?;
            let name = get_str(p, "name")?;
            let data_schema = p
                .get("dataSchema")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let commands = p
                .get("commands")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            let plugin_repository = p
                .get("pluginRepository")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if db::get_project_definition_by_code(&state.db, code)
                .await?
                .is_some()
            {
                return Err(AppError::BadRequest("Project code already exists".into()));
            }

            let pd = db::create_project_definition(
                &state.db,
                Uuid::new_v4(),
                code,
                name,
                &data_schema,
                &commands,
                plugin_repository,
            )
            .await?;
            Ok(serde_json::to_value(ProjectDefinitionResponse::from(pd)).unwrap())
        }

        // プロジェクト定義更新 — admin のみ
        // { id, name, dataSchema?, commands?, pluginRepository? }
        "update" => {
            require_system_admin(state, user_id).await?;
            let p = get_payload(&payload)?;
            let pd_id = get_uuid(p, "id")?;
            let name = get_str(p, "name")?;
            let data_schema = p
                .get("dataSchema")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let commands = p
                .get("commands")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            let plugin_repository = p
                .get("pluginRepository")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            db::update_project_definition(
                &state.db,
                pd_id,
                name,
                &data_schema,
                &commands,
                plugin_repository,
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // プロジェクト定義削除 — admin のみ { id }
        "delete" => {
            require_system_admin(state, user_id).await?;
            let p = get_payload(&payload)?;
            let pd_id = get_uuid(p, "id")?;
            db::delete_project_definition(&state.db, pd_id).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown project_definition action: {}",
            action
        ))),
    }
}

// ── org_project (組織のプロジェクト有効化/無効化) ───

async fn handle_org_project(
    state: &AppState,
    user_id: &Uuid,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match action {
        // 組織の有効プロジェクト定義一覧 { organizationId }
        "list" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_member(state, org_id, user_id).await?;
            let pds = db::list_organization_projects(&state.db, org_id).await?;
            let res: Vec<ProjectDefinitionResponse> =
                pds.into_iter().map(ProjectDefinitionResponse::from).collect();
            Ok(serde_json::to_value(res).unwrap())
        }

        // プロジェクト有効化 { organizationId, projectDefinitionId }
        "enable" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_admin(state, org_id, user_id).await?;
            let pd_id = get_uuid(p, "projectDefinitionId")?;
            db::get_project_definition(&state.db, pd_id)
                .await?
                .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
            db::enable_organization_project(&state.db, org_id, pd_id).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // プロジェクト無効化 { organizationId, projectDefinitionId }
        "disable" => {
            let p = get_payload(&payload)?;
            let org_id = get_uuid(p, "organizationId")?;
            require_admin(state, org_id, user_id).await?;
            let pd_id = get_uuid(p, "projectDefinitionId")?;
            db::disable_organization_project(&state.db, org_id, pd_id).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown org_project action: {}",
            action
        ))),
    }
}

// ── user (組織スコープのユーザー情報) ──────────────

async fn handle_user(
    state: &AppState,
    user_id: &Uuid,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match action {
        // 同じ組織に属するユーザーの情報取得 { userId }
        "get" => {
            let p = get_payload(&payload)?;
            let target_id = get_uuid(p, "userId")?;

            if *user_id != target_id {
                // 同じ組織に属しているかチェック
                let caller_orgs = db::list_user_organizations(&state.db, *user_id).await?;
                let target_orgs = db::list_user_organizations(&state.db, target_id).await?;
                let caller_org_ids: std::collections::HashSet<Uuid> =
                    caller_orgs.iter().map(|o| o.id).collect();
                let shares_org = target_orgs.iter().any(|o| caller_org_ids.contains(&o.id));
                if !shares_org {
                    return Err(AppError::Forbidden(
                        "User is not in any of your organizations".into(),
                    ));
                }
            }

            let user = db::get_user(&state.db, target_id)
                .await?
                .ok_or_else(|| AppError::NotFound("User not found".into()))?;
            Ok(serde_json::to_value(crate::models::UserResponse::from(user)).unwrap())
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown user action: {}",
            action
        ))),
    }
}
