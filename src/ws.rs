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

// ── WebSocket 接続クエリ ────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WsConnectQuery {
    /// セッション ID（既存セッションからの再接続時）
    pub session_id: Option<String>,
    /// JWT アクセストークン（新規接続時）
    pub token: Option<String>,
}

/// GET /ws — WebSocket アップグレード
pub async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<WsConnectQuery>,
    ws: WebSocketUpgrade,
) -> std::result::Result<impl IntoResponse, AppError> {
    // 認証: トークンまたはセッション ID で検証
    let (user_id, session_id) = authenticate_ws(&state, &query).await?;

    Ok(ws.on_upgrade(move |socket| handle_ws_session(state, socket, user_id, session_id)))
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
