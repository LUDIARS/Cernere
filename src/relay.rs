//! リレー / 仲介サーバ実装
//!
//! Cernere は仲介サーバを兼ねており、同一サービス内で発生する
//! 他セッションのコマンドや情報をリレーする。
//!
//! ## リレーモデル
//!
//! ```text
//! [Client A] ──WS──▶ [Cernere Relay] ──WS──▶ [Client B]
//!                          │
//!                          ├── Session Registry (in-memory)
//!                          └── Redis (state persistence)
//! ```
//!
//! リレー先は 3 種類:
//! - User: 特定ユーザの全アクティブセッション
//! - Session: 特定セッション ID
//! - Broadcast: 送信元と同じユーザの他全セッション

use axum::extract::ws::{Message, WebSocket};
use dashmap::DashMap;
use futures::stream::SplitSink;
use futures::SinkExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ws::{RelayTarget, ServerMessage};

// ── セッションレジストリ ────────────────────────────

/// アクティブ WebSocket セッションの登録情報
pub struct SessionEntry {
    pub user_id: Uuid,
    pub sender: Arc<Mutex<SplitSink<WebSocket, Message>>>,
}

/// 全アクティブセッションの in-memory レジストリ
#[derive(Default)]
pub struct SessionRegistry {
    /// session_id → SessionEntry
    sessions: DashMap<String, SessionEntry>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn register(
        &self,
        session_id: String,
        user_id: Uuid,
        sender: Arc<Mutex<SplitSink<WebSocket, Message>>>,
    ) {
        self.sessions
            .insert(session_id, SessionEntry { user_id, sender });
    }

    pub fn unregister(&self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// 特定セッションの sender を取得
    pub fn get_sender(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<SplitSink<WebSocket, Message>>>> {
        self.sessions.get(session_id).map(|e| e.sender.clone())
    }

    /// 特定ユーザの全セッション sender を取得
    pub fn get_user_senders(
        &self,
        user_id: &Uuid,
    ) -> Vec<(String, Arc<Mutex<SplitSink<WebSocket, Message>>>)> {
        self.sessions
            .iter()
            .filter(|entry| &entry.value().user_id == user_id)
            .map(|entry| (entry.key().clone(), entry.value().sender.clone()))
            .collect()
    }

    pub fn active_session_count(&self) -> usize {
        self.sessions.len()
    }
}

// ── リレーメッセージ ────────────────────────────────

/// 内部リレーターゲット (WS の RelayTarget から変換)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InternalRelayTarget {
    User(Uuid),
    Session(String),
    Broadcast(Uuid),
}

impl From<RelayTarget> for InternalRelayTarget {
    fn from(target: RelayTarget) -> Self {
        match target {
            RelayTarget::User(id) => {
                if let Ok(uuid) = Uuid::parse_str(&id) {
                    InternalRelayTarget::User(uuid)
                } else {
                    InternalRelayTarget::Session(id)
                }
            }
            RelayTarget::Session(id) => InternalRelayTarget::Session(id),
            RelayTarget::Broadcast => InternalRelayTarget::Broadcast(Uuid::nil()),
        }
    }
}

/// リレーメッセージの内部表現
pub struct RelayMessage {
    pub from_user_id: Uuid,
    pub from_session_id: String,
    pub target: InternalRelayTarget,
    pub payload: serde_json::Value,
}

/// リレーメッセージをディスパッチ
pub async fn dispatch_relay(
    registry: &SessionRegistry,
    msg: &RelayMessage,
    exclude_session: &str,
) {
    let server_msg = ServerMessage::Relayed {
        from_session: msg.from_session_id.clone(),
        payload: msg.payload.clone(),
    };
    let json = match serde_json::to_string(&server_msg) {
        Ok(j) => j,
        Err(_) => return,
    };

    match &msg.target {
        InternalRelayTarget::Session(sid) => {
            if let Some(sender) = registry.get_sender(sid) {
                let mut guard = sender.lock().await;
                let _ = guard.send(Message::Text(json.into())).await;
            }
        }

        InternalRelayTarget::User(uid) => {
            let senders = registry.get_user_senders(uid);
            for (sid, sender) in senders {
                if sid == exclude_session {
                    continue;
                }
                let mut guard = sender.lock().await;
                let _ = guard.send(Message::Text(json.clone().into())).await;
            }
        }

        InternalRelayTarget::Broadcast(_) => {
            // Broadcast: 送信元ユーザの他全セッション
            let senders = registry.get_user_senders(&msg.from_user_id);
            for (sid, sender) in senders {
                if sid == exclude_session {
                    continue;
                }
                let mut guard = sender.lock().await;
                let _ = guard.send(Message::Text(json.clone().into())).await;
            }
        }
    }
}
