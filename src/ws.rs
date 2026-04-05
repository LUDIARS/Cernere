//! WebSocket セッションハンドラ
//!
//! セッション接続を推奨する持続的インタフェース。
//! - 認証済みユーザのみ接続可能
//! - サーバから定期的に ping を送信し生存確認
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

// ── WebSocket メッセージプロトコル ───────────────────

/// クライアント → サーバ
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// pong 応答
    Pong { ts: i64 },
    /// モジュールデータリクエスト
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
pub async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<WsConnectQuery>,
    ws: WebSocketUpgrade,
) -> std::result::Result<impl IntoResponse, AppError> {
    // 認証: トークンまたはセッション ID で検証
    let (user_id, session_id) = authenticate_ws(&state, &query).await?;

    Ok(ws
        .max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_ws_session(state, socket, user_id, session_id)))
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
            // セッション切れ → ステート更新
            state
                .redis
                .update_user_state_field(&session.user_id, UserState::SessionExpired)
                .await?;
            return Err(AppError::Unauthorized("Session expired".into()));
        }
    }

    // JWT トークンで認証
    if let Some(ref token) = query.token {
        let claims = crate::auth::verify_jwt_public(token, &state.config.jwt_secret)?;
        let user_id: Uuid = claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("Invalid user ID in token".into()))?;

        // 新規 WebSocket セッション作成
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

/// WebSocket セッション本体
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
    let ping_sender = sender.clone();
    let ping_state = state.clone();
    let ping_user_id = user_id;
    let ping_session_id = session_id.clone();
    let ping_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL_SECS));
        loop {
            interval.tick().await;
            let ts = Utc::now().timestamp();
            let ping = ServerMessage::Ping { ts };
            if !send_message(&ping_sender, &ping).await {
                break;
            }
            let _ = ping_state.redis.update_last_ping(&ping_user_id, ts).await;

            // pong タイムアウト確認: last_ping からの経過で判断
            tokio::time::sleep(tokio::time::Duration::from_secs(PONG_TIMEOUT_SECS)).await;
            if let Ok(Some(full_state)) = ping_state.redis.get_user_state(&ping_user_id).await {
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
    });

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
            _ => {} // Binary, Ping/Pong at protocol level handled by axum
        }
    }

    // クリーンアップ
    ping_handle.abort();
    state.sessions.unregister(&session_id);

    // ステートを SessionExpired に変更
    let _ = state
        .redis
        .update_user_state_field(&user_id, UserState::SessionExpired)
        .await;

    tracing::info!(session_id = %session_id, "WebSocket session closed");
}

/// クライアントメッセージ処理
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
            // コマンドハンドラにディスパッチ
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
            // リレー認可チェック: User ターゲットは同一組織メンバーのみ許可
            let authorized = match &target {
                RelayTarget::Broadcast => true, // 自分の他セッションのみ → 常に許可
                RelayTarget::Session(_) => true, // セッション指定 → レジストリで存在確認される
                RelayTarget::User(target_user_str) => {
                    if let Ok(target_uid) = uuid::Uuid::parse_str(target_user_str) {
                        if target_uid == *user_id {
                            true
                        } else {
                            // 同一組織に所属しているか確認
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

/// サービス WebSocket セッション
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
                    // 認証成功
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

                    tracing::info!(service = %service_code, "Service connected");
                } else {
                    let err = ServiceServerMessage::Error {
                        code: "auth_failed".into(),
                        message: "Invalid service secret".into(),
                    };
                    send_service_message(&sender, &err).await;
                    return;
                }
            }
            _ => {
                let err = ServiceServerMessage::Error {
                    code: "service_not_found".into(),
                    message: "Service not found or inactive".into(),
                };
                send_service_message(&sender, &err).await;
                return;
            }
        }
    } else {
        let err = ServiceServerMessage::Error {
            code: "invalid_auth".into(),
            message: "Expected service_auth message".into(),
        };
        send_service_message(&sender, &err).await;
        return;
    }

    let service_code = authenticated_code.clone().unwrap();

    // Ping タスク
    let ping_sender = sender.clone();
    let ping_handle = tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL_SECS));
        loop {
            interval.tick().await;
            let ts = Utc::now().timestamp();
            let ping = ServiceServerMessage::Ping { ts };
            if !send_service_message(&ping_sender, &ping).await {
                break;
            }
        }
    });

    // メッセージ受信ループ
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(svc_msg) = serde_json::from_str::<ServiceClientMessage>(&text) {
                    match svc_msg {
                        ServiceClientMessage::Pong { .. } => {
                            // keepalive — no-op
                        }
                        ServiceClientMessage::AdmissionResponse {
                            ticket_id,
                            service_token,
                            expires_in,
                        } => {
                            // チケット消費 + ユーザーへ service_token を送信
                            handle_admission_response(
                                &state,
                                &service_code,
                                &ticket_id,
                                &service_token,
                                expires_in,
                            )
                            .await;
                        }
                        _ => {} // ServiceAuth は最初のみ
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // クリーンアップ
    ping_handle.abort();
    if let Some(ref code) = authenticated_code {
        state.service_connections.unregister(code);
        tracing::info!(service = %code, "Service disconnected");
    }
}

/// admission_response を処理: チケットを消費し、ユーザーに service_token を返す
async fn handle_admission_response(
    state: &AppState,
    service_code: &str,
    ticket_id: &str,
    service_token: &str,
    expires_in: i64,
) {
    // チケットを消費
    let ticket = match crate::db::consume_service_ticket(&state.db, ticket_id).await {
        Ok(Some(t)) => t,
        _ => {
            tracing::warn!(ticket_id = %ticket_id, "Failed to consume ticket");
            return;
        }
    };

    // サービスのエンドポイント URL を取得
    let service = match crate::db::get_service_by_code(&state.db, service_code).await {
        Ok(Some(s)) => s,
        _ => return,
    };

    // チケットのユーザーのアクティブセッションに service_token を送信
    let response = ServerMessage::ModuleResponse {
        module: "service_access".into(),
        action: "ticket_resolved".into(),
        payload: serde_json::json!({
            "serviceToken": service_token,
            "serviceUrl": service.endpoint_url,
            "serviceCode": service_code,
            "expiresIn": expires_in,
        }),
    };

    let senders = state.sessions.get_user_senders(&ticket.user_id);
    for (_sid, sender) in senders {
        send_message(&sender, &response).await;
    }
}

/// サービスメッセージ送信ヘルパー
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
