//! Cernere Service Interface
//!
//! AWS SDK スタイルのメソッドインタフェース。
//! 全ての操作は `CernereService` のメソッドとして定義され、
//! 権限検証・ビジネスロジック・レスポンス整形を担当する。
//!
//! WS コマンドハンドラ (`commands.rs`) はメッセージのパース後、
//! ここのメソッドを呼び出す。

use std::collections::HashSet;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::db;
use crate::error::AppError;
use crate::models::{
    MemberResponse, OrganizationResponse, ProjectDefinitionResponse, UserResponse,
};

type Result<T> = std::result::Result<T, AppError>;

/// Cernere のサービスインタフェース。
/// 操作を呼び出すユーザーの `user_id` をコンテキストとして保持する。
pub struct CernereService<'a> {
    state: &'a AppState,
    user_id: Uuid,
}

impl<'a> CernereService<'a> {
    pub fn new(state: &'a AppState, user_id: Uuid) -> Self {
        Self { state, user_id }
    }

    // ================================================================
    // Organization
    // ================================================================

    /// 自分が所属する組織の一覧を取得する。
    pub async fn list_organizations(&self) -> Result<Vec<OrganizationResponse>> {
        let orgs = db::list_user_organizations(&self.state.db, self.user_id).await?;
        Ok(orgs.into_iter().map(OrganizationResponse::from).collect())
    }

    /// 組織の詳細を取得する。メンバーのみ閲覧可能。
    pub async fn get_organization(&self, organization_id: Uuid) -> Result<OrganizationResponse> {
        self.require_member(organization_id).await?;
        let org = db::get_organization(&self.state.db, organization_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Organization not found".into()))?;
        Ok(OrganizationResponse::from(org))
    }

    /// 組織を作成する。作成者は自動的に owner になる。
    pub async fn create_organization(
        &self,
        name: &str,
        slug: &str,
        description: &str,
    ) -> Result<OrganizationResponse> {
        if name.is_empty() || slug.is_empty() {
            return Err(AppError::BadRequest("name and slug are required".into()));
        }
        if db::get_organization_by_slug(&self.state.db, slug)
            .await?
            .is_some()
        {
            return Err(AppError::BadRequest("Slug already taken".into()));
        }

        let org_id = Uuid::new_v4();
        let org = db::create_organization(
            &self.state.db,
            org_id,
            name,
            slug,
            description,
            self.user_id,
        )
        .await?;
        db::add_organization_member(&self.state.db, org_id, self.user_id, "owner").await?;
        Ok(OrganizationResponse::from(org))
    }

    /// 組織を更新する。admin/owner のみ。
    pub async fn update_organization(
        &self,
        organization_id: Uuid,
        name: &str,
        description: &str,
    ) -> Result<()> {
        self.require_admin(organization_id).await?;
        db::update_organization(&self.state.db, organization_id, name, description).await
    }

    /// 組織を削除する。owner のみ。
    pub async fn delete_organization(&self, organization_id: Uuid) -> Result<()> {
        let m = self.require_member(organization_id).await?;
        if m.role != "owner" {
            return Err(AppError::Forbidden(
                "Only the owner can delete an organization".into(),
            ));
        }
        db::delete_organization(&self.state.db, organization_id).await
    }

    // ================================================================
    // Member
    // ================================================================

    /// 組織メンバー一覧を取得する。メンバーのみ閲覧可能。
    pub async fn list_members(&self, organization_id: Uuid) -> Result<Vec<MemberResponse>> {
        self.require_member(organization_id).await?;
        let members = db::list_organization_members(&self.state.db, organization_id).await?;
        Ok(members.into_iter().map(MemberResponse::from).collect())
    }

    /// 組織にメンバーを追加する。admin/owner のみ。
    pub async fn add_member(
        &self,
        organization_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> Result<()> {
        self.require_admin(organization_id).await?;
        if role == "owner" {
            return Err(AppError::BadRequest(
                "Cannot assign owner role via this method".into(),
            ));
        }
        db::add_organization_member(&self.state.db, organization_id, user_id, role).await
    }

    /// メンバーのロールを更新する。admin/owner のみ。owner への昇格は owner のみ。
    pub async fn update_member_role(
        &self,
        organization_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> Result<()> {
        let caller = self.require_member(organization_id).await?;
        if role == "owner" && caller.role != "owner" {
            return Err(AppError::Forbidden(
                "Only the owner can transfer ownership".into(),
            ));
        }
        if caller.role != "owner" && caller.role != "admin" {
            return Err(AppError::Forbidden("Admin or owner role required".into()));
        }
        db::add_organization_member(&self.state.db, organization_id, user_id, role).await
    }

    /// メンバーを削除する。自分自身は脱退可能（owner 除く）。他人の削除は admin/owner のみ。
    pub async fn remove_member(
        &self,
        organization_id: Uuid,
        user_id: Uuid,
    ) -> Result<()> {
        let caller = self.require_member(organization_id).await?;
        if self.user_id == user_id {
            if caller.role == "owner" {
                return Err(AppError::BadRequest(
                    "Owner cannot leave. Transfer ownership first.".into(),
                ));
            }
        } else {
            self.require_admin(organization_id).await?;
        }
        db::remove_organization_member(&self.state.db, organization_id, user_id).await
    }

    // ================================================================
    // ProjectDefinition
    // ================================================================

    /// 全プロジェクト定義の一覧を取得する。
    pub async fn list_project_definitions(&self) -> Result<Vec<ProjectDefinitionResponse>> {
        let pds = db::list_project_definitions(&self.state.db).await?;
        Ok(pds
            .into_iter()
            .map(ProjectDefinitionResponse::from)
            .collect())
    }

    /// プロジェクト定義の詳細を取得する。
    pub async fn get_project_definition(
        &self,
        id: Uuid,
    ) -> Result<ProjectDefinitionResponse> {
        let pd = db::get_project_definition(&self.state.db, id)
            .await?
            .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
        Ok(ProjectDefinitionResponse::from(pd))
    }

    /// プロジェクト定義を作成する。system admin のみ。
    pub async fn create_project_definition(
        &self,
        code: &str,
        name: &str,
        data_schema: &serde_json::Value,
        commands: &serde_json::Value,
        plugin_repository: &str,
    ) -> Result<ProjectDefinitionResponse> {
        self.require_system_admin().await?;
        if db::get_project_definition_by_code(&self.state.db, code)
            .await?
            .is_some()
        {
            return Err(AppError::BadRequest("Project code already exists".into()));
        }
        let pd = db::create_project_definition(
            &self.state.db,
            Uuid::new_v4(),
            code,
            name,
            data_schema,
            commands,
            plugin_repository,
        )
        .await?;
        Ok(ProjectDefinitionResponse::from(pd))
    }

    /// プロジェクト定義を更新する。system admin のみ。
    pub async fn update_project_definition(
        &self,
        id: Uuid,
        name: &str,
        data_schema: &serde_json::Value,
        commands: &serde_json::Value,
        plugin_repository: &str,
    ) -> Result<()> {
        self.require_system_admin().await?;
        db::update_project_definition(
            &self.state.db,
            id,
            name,
            data_schema,
            commands,
            plugin_repository,
        )
        .await
    }

    /// プロジェクト定義を削除する。system admin のみ。
    pub async fn delete_project_definition(&self, id: Uuid) -> Result<()> {
        self.require_system_admin().await?;
        db::delete_project_definition(&self.state.db, id).await
    }

    // ================================================================
    // OrganizationProject
    // ================================================================

    /// 組織で有効なプロジェクト定義の一覧を取得する。メンバーのみ。
    pub async fn list_organization_projects(
        &self,
        organization_id: Uuid,
    ) -> Result<Vec<ProjectDefinitionResponse>> {
        self.require_member(organization_id).await?;
        let pds = db::list_organization_projects(&self.state.db, organization_id).await?;
        Ok(pds
            .into_iter()
            .map(ProjectDefinitionResponse::from)
            .collect())
    }

    /// 組織でプロジェクト定義を有効にする。admin/owner のみ。
    pub async fn enable_organization_project(
        &self,
        organization_id: Uuid,
        project_definition_id: Uuid,
    ) -> Result<()> {
        self.require_admin(organization_id).await?;
        db::get_project_definition(&self.state.db, project_definition_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Project definition not found".into()))?;
        db::enable_organization_project(&self.state.db, organization_id, project_definition_id)
            .await
    }

    /// 組織でプロジェクト定義を無効にする。admin/owner のみ。
    pub async fn disable_organization_project(
        &self,
        organization_id: Uuid,
        project_definition_id: Uuid,
    ) -> Result<()> {
        self.require_admin(organization_id).await?;
        db::disable_organization_project(&self.state.db, organization_id, project_definition_id)
            .await
    }

    // ================================================================
    // User
    // ================================================================

    /// 同じ組織に属するユーザーの情報を取得する。
    pub async fn get_user(&self, user_id: Uuid) -> Result<UserResponse> {
        if self.user_id != user_id {
            let caller_orgs = db::list_user_organizations(&self.state.db, self.user_id).await?;
            let target_orgs = db::list_user_organizations(&self.state.db, user_id).await?;
            let caller_set: HashSet<Uuid> = caller_orgs.iter().map(|o| o.id).collect();
            if !target_orgs.iter().any(|o| caller_set.contains(&o.id)) {
                return Err(AppError::Forbidden(
                    "User is not in any of your organizations".into(),
                ));
            }
        }
        let user = db::get_user(&self.state.db, user_id)
            .await?
            .ok_or_else(|| AppError::NotFound("User not found".into()))?;
        Ok(UserResponse::from(user))
    }

    // ================================================================
    // private helpers
    // ================================================================

    async fn require_member(
        &self,
        org_id: Uuid,
    ) -> Result<crate::models::OrganizationMember> {
        db::get_organization_member(&self.state.db, org_id, self.user_id)
            .await?
            .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))
    }

    async fn require_admin(
        &self,
        org_id: Uuid,
    ) -> Result<crate::models::OrganizationMember> {
        let m = self.require_member(org_id).await?;
        if m.role != "owner" && m.role != "admin" {
            return Err(AppError::Forbidden("Admin or owner role required".into()));
        }
        Ok(m)
    }

    async fn require_system_admin(&self) -> Result<()> {
        let user = db::get_user(&self.state.db, self.user_id)
            .await?
            .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;
        if user.role != "admin" {
            return Err(AppError::Forbidden("System admin role required".into()));
        }
        Ok(())
    }

    // ── Service Access (3点方式) ─────────────────

    /// ユーザーが利用可能なサービス一覧 (接続状態付き)
    pub async fn list_available_services(
        &self,
    ) -> Result<Vec<crate::models::ServiceResponse>> {
        let services = db::list_user_services(&self.state.db, self.user_id).await?;
        let result = services
            .into_iter()
            .map(|s| crate::models::ServiceResponse {
                id: s.id.to_string(),
                code: s.code.clone(),
                name: s.name,
                endpoint_url: s.endpoint_url,
                scopes: s.scopes,
                is_active: s.is_active,
                is_connected: self.state.service_connections.is_connected(&s.code),
                last_connected_at: s.last_connected_at.map(|t| t.to_rfc3339()),
            })
            .collect();
        Ok(result)
    }

    /// サービスアクセスをリクエスト: チケット発行 → サービスに admission 送信
    pub async fn request_service_access(
        &self,
        service_code: &str,
        organization_id: Option<uuid::Uuid>,
    ) -> Result<serde_json::Value> {
        // サービスが接続中か確認
        if !self.state.service_connections.is_connected(service_code) {
            return Err(AppError::BadRequest(format!(
                "Service '{}' is not currently connected",
                service_code
            )));
        }

        // サービス情報取得
        let service = db::get_service_by_code(&self.state.db, service_code)
            .await?
            .ok_or_else(|| AppError::NotFound("Service not found".into()))?;

        // ユーザーがこのサービスへのアクセス権を持つか確認
        let user_services = db::list_user_services(&self.state.db, self.user_id).await?;
        if !user_services.iter().any(|s| s.code == service_code) {
            return Err(AppError::Forbidden("Not authorized for this service".into()));
        }

        // ユーザーデータ取得
        let user = db::get_user(&self.state.db, self.user_id)
            .await?
            .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

        let user_data = serde_json::json!({
            "id": user.id.to_string(),
            "login": user.login,
            "displayName": user.display_name,
            "email": user.email,
            "avatarUrl": user.avatar_url,
            "role": user.role,
        });

        // ワンタイムチケット発行 (60秒有効)
        let ticket_code = uuid::Uuid::new_v4().to_string();
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(60);
        let ticket = db::create_service_ticket(
            &self.state.db,
            uuid::Uuid::new_v4(),
            self.user_id,
            service.id,
            &ticket_code,
            &user_data,
            organization_id,
            &service.scopes,
            expires_at,
        )
        .await?;

        // サービスに user_admission を送信
        let admission = crate::ws::ServiceServerMessage::UserAdmission {
            ticket_id: ticket.ticket_code.clone(),
            user: user_data,
            organization_id: organization_id.map(|id| id.to_string()),
            scopes: service.scopes.clone(),
        };
        self.state
            .service_connections
            .send_to_service(service_code, &admission)
            .await
            .map_err(|e| AppError::Internal(e))?;

        Ok(serde_json::json!({
            "ticketId": ticket.ticket_code,
            "serviceCode": service_code,
            "status": "pending",
            "message": "Waiting for service to issue token",
        }))
    }
}
