//! WebSocket コマンドディスパッチャ
//!
//! WS セッション中の `module_request` メッセージを受け取り、
//! `CernereService` のメソッドにマッピングして実行する。
//! 全操作は `operation_logs` テーブルに記録される。

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::service::CernereService;

/// コマンド実行結果
pub type CmdResult = std::result::Result<serde_json::Value, AppError>;

/// module_request のディスパッチ + ログ記録
pub async fn dispatch(
    state: &AppState,
    user_id: &Uuid,
    session_id: &str,
    module: &str,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    let method = format!("{}.{}", capitalize(module), capitalize(action));
    let params = payload.clone().unwrap_or(serde_json::json!({}));

    let svc = CernereService::new(state, *user_id);
    let result = execute(&svc, module, action, payload).await;

    // ログ記録（成功・失敗どちらも）
    let (status, error_msg) = match &result {
        Ok(_) => ("ok", None),
        Err(e) => ("error", Some(e.to_string())),
    };
    let _ = write_log(
        &state.db,
        *user_id,
        session_id,
        &method,
        &params,
        status,
        error_msg.as_deref(),
    )
    .await;

    result
}

/// メソッドルーティング
async fn execute(
    svc: &CernereService<'_>,
    module: &str,
    action: &str,
    payload: Option<serde_json::Value>,
) -> CmdResult {
    match (module, action) {
        // ── Organization ───────────────────────────
        ("organization", "list") => {
            let res = svc.list_organizations().await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("organization", "get") => {
            let p = require_payload(&payload)?;
            let res = svc.get_organization(get_uuid(p, "organizationId")?).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("organization", "create") => {
            let p = require_payload(&payload)?;
            let res = svc
                .create_organization(
                    get_str(p, "name")?,
                    get_str(p, "slug")?,
                    opt_str(p, "description"),
                )
                .await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("organization", "update") => {
            let p = require_payload(&payload)?;
            svc.update_organization(
                get_uuid(p, "organizationId")?,
                get_str(p, "name")?,
                opt_str(p, "description"),
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        ("organization", "delete") => {
            let p = require_payload(&payload)?;
            svc.delete_organization(get_uuid(p, "organizationId")?).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // ── Member ─────────────────────────────────
        ("member", "list") => {
            let p = require_payload(&payload)?;
            let res = svc.list_members(get_uuid(p, "organizationId")?).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("member", "add") => {
            let p = require_payload(&payload)?;
            svc.add_member(
                get_uuid(p, "organizationId")?,
                get_uuid(p, "userId")?,
                p.get("role").and_then(|v| v.as_str()).unwrap_or("member"),
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        ("member", "update_role") => {
            let p = require_payload(&payload)?;
            svc.update_member_role(
                get_uuid(p, "organizationId")?,
                get_uuid(p, "userId")?,
                get_str(p, "role")?,
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        ("member", "remove") => {
            let p = require_payload(&payload)?;
            svc.remove_member(
                get_uuid(p, "organizationId")?,
                get_uuid(p, "userId")?,
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // ── ProjectDefinition ──────────────────────
        ("project_definition", "list") => {
            let res = svc.list_project_definitions().await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("project_definition", "get") => {
            let p = require_payload(&payload)?;
            let res = svc.get_project_definition(get_uuid(p, "id")?).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("project_definition", "create") => {
            let p = require_payload(&payload)?;
            let data_schema = p.get("dataSchema").cloned().unwrap_or(serde_json::json!({}));
            let commands = p.get("commands").cloned().unwrap_or(serde_json::json!([]));
            let res = svc
                .create_project_definition(
                    get_str(p, "code")?,
                    get_str(p, "name")?,
                    &data_schema,
                    &commands,
                    opt_str(p, "pluginRepository"),
                )
                .await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("project_definition", "update") => {
            let p = require_payload(&payload)?;
            let data_schema = p.get("dataSchema").cloned().unwrap_or(serde_json::json!({}));
            let commands = p.get("commands").cloned().unwrap_or(serde_json::json!([]));
            svc.update_project_definition(
                get_uuid(p, "id")?,
                get_str(p, "name")?,
                &data_schema,
                &commands,
                opt_str(p, "pluginRepository"),
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        ("project_definition", "delete") => {
            let p = require_payload(&payload)?;
            svc.delete_project_definition(get_uuid(p, "id")?).await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // ── OrganizationProject ────────────────────
        ("org_project", "list") => {
            let p = require_payload(&payload)?;
            let res = svc
                .list_organization_projects(get_uuid(p, "organizationId")?)
                .await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        ("org_project", "enable") => {
            let p = require_payload(&payload)?;
            svc.enable_organization_project(
                get_uuid(p, "organizationId")?,
                get_uuid(p, "projectDefinitionId")?,
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        ("org_project", "disable") => {
            let p = require_payload(&payload)?;
            svc.disable_organization_project(
                get_uuid(p, "organizationId")?,
                get_uuid(p, "projectDefinitionId")?,
            )
            .await?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // ── User ───────────────────────────────────
        ("user", "get") => {
            let p = require_payload(&payload)?;
            let res = svc.get_user(get_uuid(p, "userId")?).await?;
            Ok(serde_json::to_value(res).unwrap())
        }

        _ => Err(AppError::BadRequest(format!(
            "Unknown method: {}.{}",
            module, action
        ))),
    }
}

// ── ログ記録 ───────────────────────────────────────

async fn write_log(
    pool: &PgPool,
    user_id: Uuid,
    session_id: &str,
    method: &str,
    params: &serde_json::Value,
    status: &str,
    error: Option<&str>,
) -> std::result::Result<(), sqlx::Error> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO operation_logs (id, user_id, session_id, method, params, status, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(user_id)
    .bind(session_id)
    .bind(method)
    .bind(params)
    .bind(status)
    .bind(error)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

// ── ペイロードパーサ ───────────────────────────────

fn require_payload(payload: &Option<serde_json::Value>) -> Result<&serde_json::Value, AppError> {
    payload
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Payload is required".into()))
}

fn get_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, AppError> {
    v.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest(format!("Missing field: {}", key)))
}

fn opt_str<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn get_uuid(v: &serde_json::Value, key: &str) -> Result<Uuid, AppError> {
    let s = get_str(v, key)?;
    s.parse::<Uuid>()
        .map_err(|_| AppError::BadRequest(format!("Invalid UUID: {}", key)))
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}
