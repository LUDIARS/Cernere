//! WebSocket セッションハンドラ
//!
//! セッション接続を推奨する持続的インタフェース。
//! - 認証済みユーザ: JWT/セッション ID で接続 → 全コマンド利用可能
//! - ゲスト: 認証情報なしで接続 → auth コマンド (register/login) のみ利用可能
//!   → 認証成功後にセッションが昇格し全コマンド利用可能に
//! - サーバから定期的�� ping を送信し生存確認
//! - ユーザステートの変更をリアルタイムに通知
//! - 同一サービス内のリレーメッセージを中継

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use chrono::Utc;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::relay::RelayMessage;
use crate::session_state::{UserFullState, UserState};

/// ping 間隔（秒）
const PING_INTERVAL_SECS: u64 = 30;
/// pong タイムアウト（秒）— この期間内に pong がなければ切断
const PONG_TIMEOUT_SECS: u64 = 10;
/// WebSocket メッセージの最大サイズ (256 KB)
const MAX_MESSAGE_SIZE: usize = 256 * 1024;

// ── WebSocket メッセージプロトコル ─��─────────────────

/// クライアント → サーバ
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// pong 応答
    Pong { ts: i64 },
    /// モジュールデータリクエ��ト
    ModuleRequest { module: String, action: String, payload: Option<serde_json::Value> },
    /// リレーメッセージ（他セッションへ）
    Relay { target: RelayTarget, payload: serde_json::Value },
}

/// サーバ → クライアント
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// 接続確立 — セッション情報を返す
    Connected { session_id: String, user_state: UserFullState },
    /// ゲスト接続確立 — 認証前の限定セッション
    GuestConnected { session_id: String },
    /// 認証成功 — ゲストセッションが昇格
    Authenticated { session_id: String, user_state: UserFullState, access_token: String, refresh_token: String },
    /// ping — クライアントは pong で応答すべき
    Ping { ts: i64 },
    /// ステート変更通知
    StateChanged { user_state: UserFullState },
    /// モジュールデータ応答
    ModuleResponse { module: String, action: String, payload: serde_json::Value },
    /// リレーメッセージ（他セッションから）
    Relayed { from_session: String, payload: serde_json::Value },
    /// エラー
    Error { code: String, message: String },
}

/// リレー先の指定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayTarget {
    /// 特定ユーザの全セッション
    User(String),
    /// 特定セッション
    Session(String),
    /// 同一ユーザの他セッション全て
    Broadcast,
}

// ── サービス接続プロトコル ──────────────────────────

/// サービス → Cernere (サービス接続用)
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceClientMessage {
    /// サービス認証
    ServiceAuth { service_code: String, service_secret: String },
    /// ユーザー受け入れ応答
    AdmissionResponse {
        ticket_id: String,
        service_token: String,
        expires_in: i64,
    },
    /// Pong
    Pong { ts: i64 },
}

/// Cernere → サービス
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceServerMessage {
    /// 認証成功
    ServiceAuthenticated { service_id: String },
    /// ユーザー受け入れ要求
    UserAdmission {
        ticket_id: String,
        user: serde_json::Value,
        organization_id: Option<String>,
        scopes: serde_json::Value,
    },
    /// ユーザー無効化
    UserRevoke { user_id: Uuid },
    /// Ping
    Ping { ts: i64 },
    /// エラー
    Error { code: String, message: String },
}

// ── WebSocket 接続クエリ ────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WsConnectQuery {
    /// セッション ID（既存セッションからの再接続時）
    pub session_id: Option<String>,
    /// JWT アクセストークン（新規接続時）
    pub token: Option<String>,
}

/// GET /auth — WebSocket アップグレード
///
/// - token あり → 認証済みセッション
/// - session_id あり → 既存セッション復帰
/// - どちらもなし → ゲストセッション（auth コマンドのみ利用可���）
pub async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<WsConnectQuery>,
    ws: WebSocketUpgrade,
) -> std::result::Result<impl IntoResponse, AppError> {
    let auth_result = authenticate_ws(&state, &query).await;

    match auth_result {
        Ok((user_id, session_id)) => {
            // 認証済みセッション
            Ok(ws
                .max_message_size(MAX_MESSAGE_SIZE)
                .on_upgrade(move |socket| handle_ws_session(state, socket, user_id, session_id)))
        }
        Err(_) if query.token.is_none() && query.session_id.is_none() => {
            // ゲストセッション（認証情報なし）
            Ok(ws
                .max_message_size(MAX_MESSAGE_SIZE)
                .on_upgrade(move |socket| handle_guest_ws_session(state, socket)))
        }
        Err(e) => Err(e),
    }
}

/// WebSocket 認証
async fn authenticate_ws(
    state: &AppState,
    query: &WsConnectQuery,
) -> std::result::Result<(Uuid, String), AppError> {
    // セッション ID がある場合: 既存セッション復帰
    if let Some(ref sid) = query.session_id {
        if let Some(session) = state.redis.get_session(sid).await? {
            if Utc::now() < session.expires_at {
                return Ok((session.user_id, session.id));
            }
            state
                .redis
                .update_user_state_field(&session.user_id, UserState::SessionExpired)
                .await?;
            return Err(AppError::Unauthorized("Session expired".into()));
        }
    }

    // JWT トークンで認���
    if let Some(ref token) = query.token {
        let claims = crate::auth::verify_jwt_public(token, &state.config.jwt_secret)?;
        let user_id: Uuid = claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("Invalid user ID in token".into()))?;

        let session_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let session = crate::models::Session {
            id: session_id.clone(),
            user_id,
            expires_at: now + chrono::Duration::seconds(crate::SESSION_TTL_SECS),
            created_at: now,
            access_token: token.clone(),
        };
        state.redis.put_session(&session).await?;

        return Ok((user_id, session_id));
    }

    Err(AppError::Unauthorized(
        "WebSocket connection requires session_id or token".into(),
    ))
}

// ── 認証済みセッション ─────────────────────────────

/// WebSocket セッション本体（認証済み）
async fn handle_ws_session(
    state: AppState,
    socket: WebSocket,
    user_id: Uuid,
    session_id: String,
) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));

    // セッションレジストリに登録
    state
        .sessions
        .register(session_id.clone(), user_id, sender.clone());

    // ユーザステートを LoggedIn に設定
    let now = Utc::now();
    let user_state = UserFullState {
        user_id,
        session_id: session_id.clone(),
        state: UserState::LoggedIn,
        modules: Vec::new(),
        last_ping_at: now.timestamp(),
    };
    let _ = state.redis.set_user_state(&user_state).await;

    // Connected メッセージ送信
    let connected = ServerMessage::Connected {
        session_id: session_id.clone(),
        user_state: user_state.clone(),
    };
    send_message(&sender, &connected).await;

    // Ping タスク起動
    let ping_handle = spawn_ping_task(&state, &sender, user_id, &session_id);

    // メッセージ受信ループ
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    handle_client_message(&state, &sender, &user_id, &session_id, client_msg)
                        .await;
                } else {
                    let err = ServerMessage::Error {
                        code: "invalid_message".into(),
                        message: "Failed to parse message".into(),
                    };
                    send_message(&sender, &err).await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // クリ��ンアップ
    ping_handle.abort();
    state.sessions.unregister(&session_id);
    let _ = state
        .redis
        .update_user_state_field(&user_id, UserState::SessionExpired)
        .await;

    tracing::info!(session_id = %session_id, "WebSocket session closed");
}

// ── ゲストセッション ──────────��────────────────────

/// ゲスト WebSocket セッション
///
/// 認証情報なしで接続。auth モジュールのコマンド (register/login) のみ受付。
/// 認証成功後にセッションが昇格し、全コマンド利用可能になる。
async fn handle_guest_ws_session(
    state: AppState,
    socket: WebSocket,
) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));
    let session_id = format!("guest_{}", Uuid::new_v4());

    tracing::info!(session_id = %session_id, "Guest WebSocket session started");

    // GuestConnected メッセージ送信
    let connected = ServerMessage::GuestConnected {
        session_id: session_id.clone(),
    };
    send_message(&sender, &connected).await;

    // ゲストセッションのメッセージ受信ループ
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    match client_msg {
                        ClientMessage::Pong { .. } => {
                            // ゲストでも pong は受け付ける
                        }
                        ClientMessage::ModuleRequest { ref module, ref action, ref payload } => {
                            // ゲストは auth モジュールのみ許可
                            if module != "auth" {
                                let err = ServerMessage::Error {
                                    code: "guest_restricted".into(),
                                    message: format!(
                                        "Guest sessions can only use 'auth' module. Got '{}'",
                                        module
                                    ),
                                };
                                send_message(&sender, &err).await;
                                continue;
                            }

                            // auth コマンドをディスパッチ
                            let result = handle_guest_auth_command(
                                &state, action, payload.clone(),
                            ).await;

                            match result {
                                Ok(auth_response) => {
                                    // 認証成功 → セッション昇格
                                    if let (Some(user_id), Some(access_token), Some(refresh_token)) = (
                                        auth_response.get("userId").and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()),
                                        auth_response.get("accessToken").and_then(|v| v.as_str()),
                                        auth_response.get("refreshToken").and_then(|v| v.as_str()),
                                    ) {
                                        // Redis にセッションを作成
                                        let now = Utc::now();
                                        let new_session_id = Uuid::new_v4().to_string();
                                        let session = crate::models::Session {
                                            id: new_session_id.clone(),
                                            user_id,
                                            expires_at: now + chrono::Duration::seconds(crate::SESSION_TTL_SECS),
                                            created_at: now,
                                            access_token: access_token.to_string(),
                                        };
                                        let _ = state.redis.put_session(&session).await;

                                        // セッションレジストリに登録
                                        state.sessions.register(
                                            new_session_id.clone(),
                                            user_id,
                                            sender.clone(),
                                        );

                                        // ユーザステートを LoggedIn に設定
                                        let user_state = UserFullState {
                                            user_id,
                                            session_id: new_session_id.clone(),
                                            state: UserState::LoggedIn,
                                            modules: Vec::new(),
                                            last_ping_at: now.timestamp(),
                                        };
                                        let _ = state.redis.set_user_state(&user_state).await;

                                        // Authenticated メッセージを送信
                                        let auth_msg = ServerMessage::Authenticated {
                                            session_id: new_session_id.clone(),
                                            user_state: user_state.clone(),
                                            access_token: access_token.to_string(),
                                            refresh_token: refresh_token.to_string(),
                                        };
                                        send_message(&sender, &auth_msg).await;

                                        tracing::info!(
                                            session_id = %new_session_id,
                                            user_id = %user_id,
                                            "Guest session promoted to authenticated"
                                        );

                                        // Ping タスク起動 & 認証済みループに移行
                                        let ping_handle = spawn_ping_task(&state, &sender, user_id, &new_session_id);

                                        // 認証済みメッセージループに切り替え
                                        handle_authenticated_loop(
                                            &state, &sender, &mut receiver, user_id, &new_session_id,
                                        ).await;

                                        // クリーンアップ
                                        ping_handle.abort();
                                        state.sessions.unregister(&new_session_id);
                                        let _ = state
                                            .redis
                                            .update_user_state_field(&user_id, UserState::SessionExpired)
                                            .await;

                                        tracing::info!(session_id = %new_session_id, "Promoted session closed");
                                        return;
                                    } else {
                                        // 認証結果だが昇格条件を満たさない（例: MFA 要求）
                                        let response = ServerMessage::ModuleResponse {
                                            module: "auth".into(),
                                            action: action.clone(),
                                            payload: auth_response,
                                        };
                                        send_message(&sender, &response).await;
                                    }
                                }
                                Err(e) => {
                                    let err = ServerMessage::Error {
                                        code: "auth_error".into(),
                                        message: e.to_string(),
                                    };
                                    send_message(&sender, &err).await;
                                }
                            }
                        }
                        ClientMessage::Relay { .. } => {
                            let err = ServerMessage::Error {
                                code: "guest_restricted".into(),
                                message: "Guest sessions cannot use relay".into(),
                            };
                            send_message(&sender, &err).await;
                        }
                    }
                } else {
                    let err = ServerMessage::Error {
                        code: "invalid_message".into(),
                        message: "Failed to parse message".into(),
                    };
                    send_message(&sender, &err).await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    tracing::info!(session_id = %session_id, "Guest WebSocket session closed");
}

/// ゲスト auth コマンド処理
///
/// register / login を処理し、成功時は userId + tokens を含む JSON を返す。
async fn handle_guest_auth_command(
    state: &AppState,
    action: &str,
    payload: Option<serde_json::Value>,
) -> std::result::Result<serde_json::Value, AppError> {
    let p = payload.ok_or_else(|| AppError::BadRequest("Payload required".into()))?;

    match action {
        "register" => {
            let name = p.get("name").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::BadRequest("name is required".into()))?;
            let email = p.get("email").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::BadRequest("email is required".into()))?;
            let password = p.get("password").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::BadRequest("password is required".into()))?;

            if password.len() < 8 {
                return Err(AppError::BadRequest("Password must be at least 8 characters".into()));
            }

            // レートリミット
            state.redis.check_rate_limit(
                &format!("ws_register:{}", email), 5, 600,
            ).await?;

            if crate::db::get_user_by_email(&state.db, email).await?.is_some() {
                return Err(AppError::BadRequest("Registration failed. Please check your input and try again.".into()));
            }

            let password_hash = bcrypt::hash(password, 12)
                .map_err(|e| AppError::Internal(format!("Hash failed: {}", e)))?;

            let user_count = crate::db::count_users(&state.db).await?;
            let role = if user_count == 0 { "admin" } else { "general" };
            let now = Utc::now();

            let user = crate::models::User {
                id: Uuid::new_v4(),
                github_id: None,
                login: name.to_string(),
                display_name: name.to_string(),
                avatar_url: String::new(),
                email: Some(email.to_string()),
                role: role.to_string(),
                password_hash: Some(password_hash),
                google_id: None,
                google_access_token: None,
                google_refresh_token: None,
                google_token_expires_at: None,
                google_scopes: None,
                totp_secret: None,
                totp_enabled: false,
                phone_number: None,
                phone_verified: false,
                mfa_enabled: false,
                mfa_methods: serde_json::json!([]),
                last_login_at: Some(now),
                created_at: now,
                updated_at: now,
            };
            crate::db::upsert_user(&state.db, &user).await?;

            let (access_token, refresh_token) = crate::auth::generate_tokens_public(&user, &state.config.jwt_secret)?;
            let expires_at = now + chrono::Duration::days(30);
            crate::db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

            Ok(serde_json::json!({
                "userId": user.id.to_string(),
                "user": crate::models::UserResponse::from(user),
                "accessToken": access_token,
                "refreshToken": refresh_token,
            }))
        }

        "login" => {
            let email = p.get("email").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::BadRequest("email is required".into()))?;
            let password = p.get("password").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::BadRequest("password is required".into()))?;

            // レ��トリミット
            state.redis.check_rate_limit(
                &format!("ws_login:{}", email), 10, 900,
            ).await?;

            let user = crate::db::get_user_by_email(&state.db, email)
                .await?
                .ok_or_else(|| AppError::Unauthorized("Invalid credentials".into()))?;

            let hash = user.password_hash.as_ref()
                .ok_or_else(|| AppError::Unauthorized("Password login not available for this account".into()))?;

            let valid = bcrypt::verify(password, hash)
                .map_err(|e| AppError::Internal(format!("Verify failed: {}", e)))?;
            if !valid {
                return Err(AppError::Unauthorized("Invalid credentials".into()));
            }

            // MFA チェッ��
            if user.mfa_enabled {
                let methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone()).unwrap_or_default();
                let mfa_token = crate::auth::generate_mfa_token_public(&user, &state.config.jwt_secret)?;
                return Ok(serde_json::json!({
                    "mfaRequired": true,
                    "mfaToken": mfa_token,
                    "mfaMethods": methods,
                }));
            }

            let now = Utc::now();
            let mut updated = user.clone();
            updated.last_login_at = Some(now);
            updated.updated_at = now;
            crate::db::upsert_user(&state.db, &updated).await?;

            let (access_token, refresh_token) = crate::auth::generate_tokens_public(&user, &state.config.jwt_secret)?;
            let expires_at = now + chrono::Duration::days(30);
            crate::db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

            Ok(serde_json::json!({
                "userId": user.id.to_string(),
                "user": crate::models::UserResponse::from(user),
                "accessToken": access_token,
                "refreshToken": refresh_token,
            }))
        }

        _ => Err(AppError::BadRequest(format!(
            "Guest auth action '{}' not supported. Use 'register' or 'login'.", action
        ))),
    }
}

// ── 共通: 認証済みメッセージループ ──────────────────

/// 認証済みセッションのメッセージループ（昇格後のゲストにも使用）
async fn handle_authenticated_loop(
    state: &AppState,
    sender: &Arc<Mutex<SplitSink<WebSocket, Message>>>,
    receiver: &mut futures::stream::SplitStream<WebSocket>,
    user_id: Uuid,
    session_id: &str,
) {
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    handle_client_message(state, sender, &user_id, session_id, client_msg)
                        .await;
                } else {
                    let err = ServerMessage::Error {
                        code: "invalid_message".into(),
                        message: "Failed to parse message".into(),
                    };
                    send_message(sender, &err).await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }
}

// ── 共通: Ping タスク ──────────────────────────────

fn spawn_ping_task(
    state: &AppState,
    sender: &Arc<Mutex<SplitSink<WebSocket, Message>>>,
    user_id: Uuid,
    session_id: &str,
) -> tokio::task::JoinHandle<()> {
    let ping_sender = sender.clone();
    let ping_state = state.clone();
    let ping_session_id = session_id.to_string();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL_SECS));
        loop {
            interval.tick().await;
            let ts = Utc::now().timestamp();
            let ping = ServerMessage::Ping { ts };
            if !send_message(&ping_sender, &ping).await {
                break;
            }
            let _ = ping_state.redis.update_last_ping(&user_id, ts).await;

            tokio::time::sleep(tokio::time::Duration::from_secs(PONG_TIMEOUT_SECS)).await;
            if let Ok(Some(full_state)) = ping_state.redis.get_user_state(&user_id).await {
                let elapsed = Utc::now().timestamp() - full_state.last_ping_at;
                if elapsed > (PING_INTERVAL_SECS + PONG_TIMEOUT_SECS) as i64 {
                    tracing::warn!(
                        session_id = %ping_session_id,
                        "Pong timeout — disconnecting"
                    );
                    break;
                }
            }
        }
    })
}

// ── 共通: クライアントメッセージ処理 ────────────────

/// クライアントメッセージ処理（認証済みセッション用）
async fn handle_client_message(
    state: &AppState,
    sender: &Arc<Mutex<SplitSink<WebSocket, Message>>>,
    user_id: &Uuid,
    session_id: &str,
    msg: ClientMessage,
) {
    match msg {
        ClientMessage::Pong { ts } => {
            let _ = state.redis.update_last_ping(user_id, ts).await;
        }

        ClientMessage::ModuleRequest {
            module,
            action,
            payload,
        } => {
            let result =
                crate::commands::dispatch(state, user_id, session_id, &module, &action, payload).await;

            match result {
                Ok(response_payload) => {
                    let response = ServerMessage::ModuleResponse {
                        module,
                        action,
                        payload: response_payload,
                    };
                    send_message(sender, &response).await;
                }
                Err(e) => {
                    let err = ServerMessage::Error {
                        code: "command_error".into(),
                        message: e.to_string(),
                    };
                    send_message(sender, &err).await;
                }
            }
        }

        ClientMessage::Relay { target, payload } => {
            let authorized = match &target {
                RelayTarget::Broadcast => true,
                RelayTarget::Session(_) => true,
                RelayTarget::User(target_user_str) => {
                    if let Ok(target_uid) = uuid::Uuid::parse_str(target_user_str) {
                        if target_uid == *user_id {
                            true
                        } else {
                            match crate::db::share_organization(&state.db, *user_id, target_uid).await {
                                Ok(shared) => shared,
                                Err(_) => false,
                            }
                        }
                    } else {
                        false
                    }
                }
            };

            if !authorized {
                let err = ServerMessage::Error {
                    code: "relay_forbidden".into(),
                    message: "Not authorized to relay to this target".into(),
                };
                send_message(sender, &err).await;
                return;
            }

            let relay_msg = RelayMessage {
                from_user_id: *user_id,
                from_session_id: session_id.to_string(),
                target: target.into(),
                payload: payload.clone(),
            };
            crate::relay::dispatch_relay(&state.sessions, &relay_msg, session_id).await;
        }
    }
}

/// メッセージ送信ヘルパー
async fn send_message(
    sender: &Arc<Mutex<SplitSink<WebSocket, Message>>>,
    msg: &ServerMessage,
) -> bool {
    if let Ok(json) = serde_json::to_string(msg) {
        let mut guard = sender.lock().await;
        guard.send(Message::Text(json.into())).await.is_ok()
    } else {
        false
    }
}

// ── サービス WebSocket エンドポイント ───────────────

#[derive(Debug, Deserialize)]
pub struct ServiceWsQuery {
    pub service_code: Option<String>,
}

/// GET /ws/service — サービス用 WebSocket アップグレード
pub async fn service_ws_upgrade(
    State(state): State<AppState>,
    Query(_query): Query<ServiceWsQuery>,
    ws: WebSocketUpgrade,
) -> std::result::Result<impl IntoResponse, AppError> {
    Ok(ws
        .max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_service_ws(state, socket)))
}

/// サービス WebSocket セッション (メッセージ送信ヘルパー)
async fn send_service_message(
    sender: &Arc<Mutex<SplitSink<WebSocket, Message>>>,
    msg: &ServiceServerMessage,
) -> bool {
    if let Ok(json) = serde_json::to_string(msg) {
        let mut guard = sender.lock().await;
        guard.send(Message::Text(json.into())).await.is_ok()
    } else {
        false
    }
}

/// サー��ス WebSocket セッション
async fn handle_service_ws(state: AppState, socket: WebSocket) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));
    let mut authenticated_code: Option<String> = None;

    // 最初のメッセージで認証を待つ (10秒タイムアウト)
    let auth_result = tokio::time::timeout(
        tokio::time::Duration::from_secs(10),
        receiver.next(),
    )
    .await;

    let first_msg = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        _ => {
            let err = ServiceServerMessage::Error {
                code: "auth_timeout".into(),
                message: "Authentication timeout".into(),
            };
            send_service_message(&sender, &err).await;
            return;
        }
    };

    // service_auth メッセージを解析
    if let Ok(ServiceClientMessage::ServiceAuth {
        service_code,
        service_secret,
    }) = serde_json::from_str(&first_msg)
    {
        match crate::db::get_service_by_code(&state.db, &service_code).await {
            Ok(Some(svc)) if svc.is_active => {
                let valid = bcrypt::verify(&service_secret, &svc.service_secret_hash)
                    .unwrap_or(false);
                if valid {
                    state.service_connections.register(
                        service_code.clone(),
                        svc.id,
                        sender.clone(),
                    );
                    let _ = crate::db::update_service_connected(&state.db, svc.id).await;
                    authenticated_code = Some(service_code.clone());

                    let ok = ServiceServerMessage::ServiceAuthenticated {
                        service_id: svc.id.to_string(),
                    };
                    send_service_message(&sender, &ok).await;

                    tracing::info!(service_code = %service_code, "Service WebSocket authenticated");
                } else {
                    let err = ServiceServerMessage::Error {
                        code: "auth_failed".into(),
                        message: "Invalid service credentials".into(),
                    };
                    send_service_message(&sender, &err).await;
                    return;
                }
            }
            _ => {
                let err = ServiceServerMessage::Error {
                    code: "auth_failed".into(),
                    message: "Service not found or inactive".into(),
                };
                send_service_message(&sender, &err).await;
                return;
            }
        }
    } else {
        let err = ServiceServerMessage::Error {
            code: "invalid_message".into(),
            message: "Expected service_auth message".into(),
        };
        send_service_message(&sender, &err).await;
        return;
    }

    // 認証済みサービス接続のメッセージループ
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(svc_msg) = serde_json::from_str::<ServiceClientMessage>(&text) {
                    match svc_msg {
                        ServiceClientMessage::Pong { .. } => {}
                        ServiceClientMessage::AdmissionResponse { ticket_id, service_token, expires_in } => {
                            tracing::info!(ticket_id = %ticket_id, "Service admission response received");
                            let _ = (service_token, expires_in); // TODO: Process admission
                        }
                        _ => {}
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // クリーンアップ
    if let Some(code) = &authenticated_code {
        state.service_connections.unregister(code);
        tracing::info!(service_code = %code, "Service WebSocket disconnected");
    }
}
