# Cernere リレー / 仲介サーバ 設計書

## 1. 概要

Cernere は認証・セッション管理サーバであると同時に、**仲介サーバ (Relay Server)** を兼ねる。
同一サービス内で発生する他セッションのコマンドや情報をリレーする役割を持つ。

```
┌──────────┐     WebSocket      ┌──────────────────┐     WebSocket      ┌──────────┐
│ Client A ├────────────────────┤                  ├────────────────────┤ Client B │
│ (Ars)    │                    │  Cernere Relay   │                    │ (Ars)    │
└──────────┘                    │                  │                    └──────────┘
                                │  ┌────────────┐  │
                                │  │ Session    │  │
                                │  │ Registry   │  │
                                │  └────────────┘  │
                                │  ┌────────────┐  │
                                │  │   Redis    │  │
                                │  │   State    │  │
                                │  └────────────┘  │
                                └──────────────────┘
```

## 2. 設計原則

1. **セッション中心**: 全通信はセッション ID で識別される
2. **Redis ステート連動**: ユーザ/データの状態変更はリレーと連動する
3. **最小権限**: リレーメッセージは同一ユーザのセッション間に制限（デフォルト）
4. **非同期・ノンブロッキング**: tokio + axum WebSocket による完全非同期設計

## 3. アーキテクチャ

### 3.1 コンポーネント構成

| コンポーネント | 責務 |
|---|---|
| **SessionRegistry** | アクティブ WebSocket セッションの in-memory 管理 |
| **RelayDispatcher** | リレーメッセージのルーティング・配信 |
| **StateSync** | Redis ステートとリレーの連動 |
| **PingMonitor** | セッション生存確認 (ping/pong) |

### 3.2 セッションレジストリ

```rust
SessionRegistry {
    sessions: DashMap<SessionId, SessionEntry>
}

SessionEntry {
    user_id: Uuid,
    sender: Arc<Mutex<SplitSink<WebSocket, Message>>>
}
```

- **DashMap** による並行安全なセッション管理
- セッション接続時に `register()`、切断時に `unregister()`
- ユーザ ID によるセッション検索をサポート

### 3.3 リレーターゲット

| ターゲット | 説明 | ユースケース |
|---|---|---|
| `Session(id)` | 特定セッション ID に送信 | ダイレクトメッセージ |
| `User(id)` | 特定ユーザの全アクティブセッション | マルチデバイス同期 |
| `Broadcast` | 送信元ユーザの他全セッション | 自身のデバイス間同期 |

## 4. メッセージプロトコル

### 4.1 クライアント → サーバ

```json
{
  "type": "relay",
  "target": { "user": "<user_id>" },
  "payload": { ... }
}
```

```json
{
  "type": "relay",
  "target": { "session": "<session_id>" },
  "payload": { ... }
}
```

```json
{
  "type": "relay",
  "target": "broadcast",
  "payload": { ... }
}
```

### 4.2 サーバ → クライアント (リレー配信)

```json
{
  "type": "relayed",
  "from_session": "<sender_session_id>",
  "payload": { ... }
}
```

### 4.3 その他のメッセージ型

| Type | 方向 | 説明 |
|---|---|---|
| `connected` | S→C | 接続確立、セッション情報返却 |
| `ping` | S→C | 生存確認 (30秒間隔) |
| `pong` | C→S | ping 応答 |
| `state_changed` | S→C | ユーザステート変更通知 |
| `module_request` | C→S | モジュールデータリクエスト |
| `module_response` | S→C | モジュールデータ応答 |
| `error` | S→C | エラー通知 |

## 5. ステート管理との連動

### 5.1 ユーザ State

```
None → LoggedIn → SessionExpired → None
  ↑                     │
  └─────────────────────┘ (再認証)
```

| State | 条件 | Redis キー |
|---|---|---|
| `none` | セッション未確立 | キーなし |
| `logged_in` | WebSocket/HTTP 認証済み | `ustate:{user_id}` |
| `session_expired` | ping タイムアウト or TTL 超過 | `ustate:{user_id}` |

### 5.2 ユーザデータ State (モジュール単位)

```
None → Exists → Updated → Exists
  ↑               │
  └───────────────┘ (データ消去)
```

| State | 条件 | Redis キー |
|---|---|---|
| `none` | モジュールデータ未取得 | キーなし |
| `exists` | データ取得済み (キャッシュ有) | `mstate:{user_id}:{module}` |
| `updated` | サーバ側で更新あり (要リフレッシュ) | `mstate:{user_id}:{module}` |

これは **モデルキャッシュ** と同義であり、クライアントは `updated` を受信した場合に最新データを再取得する。

## 6. リレーのセキュリティ

### 6.1 認証

- WebSocket 接続には JWT トークンまたは既存セッション ID が必須
- 未認証接続は即座に拒否される

### 6.2 スコープ制限

- **デフォルト**: 同一ユーザのセッション間のみリレー可能
- **将来拡張**: サービスレベルのリレー (管理者間、チーム間) は Phase 2 で設計

### 6.3 レート制限

- リレーメッセージのレート制限は Phase 2 で実装
- 初期実装ではサーバ側の DDoS 対策として接続数上限を設定

## 7. 接続ライフサイクル

```
1. クライアント → GET /auth?token=<jwt>        (WebSocket アップグレード)
2. サーバ → { type: "connected", ... }         (セッション確立)
3. サーバ → { type: "ping", ts: ... }          (30秒ごと)
4. クライアント → { type: "pong", ts: ... }    (応答)
5. クライアント → { type: "relay", ... }       (リレーメッセージ)
6. サーバ → { type: "relayed", ... }           (他セッションへ配信)
7. (切断時) サーバ: unregister + state → SessionExpired
```

### 7.1 再接続フロー

```
1. クライアント → GET /auth?session_id=<sid>    (既存セッション復帰)
2. セッション有効 → { type: "connected", ... }
3. セッション無効 → 401 Unauthorized → ログイン画面遷移
```

## 8. 将来の拡張計画

### Phase 2: サービス間リレー
- 異なるユーザ間のリレー (権限ベース)
- チーム/グループ単位のブロードキャスト
- メッセージ永続化 (Redis Streams or PostgreSQL)

### Phase 3: QUIC 対応
- HTTP/3 + QUIC によるセッション接続
- WebSocket と QUIC の自動ネゴシエーション
- 低レイテンシ・高信頼性接続

### Phase 4: 分散リレー
- 複数 Cernere ノード間のリレー同期
- Redis Pub/Sub によるクロスノードメッセージング
- ノード障害時の自動フェイルオーバー

## 9. 実装ステータス

| 機能 | ステータス |
|---|---|
| SessionRegistry (in-memory) | ✅ 実装済み |
| RelayDispatcher (Session/User/Broadcast) | ✅ 実装済み |
| WebSocket ハンドラ | ✅ 実装済み |
| Ping/Pong 生存確認 | ✅ 実装済み |
| ユーザ State (Redis) | ✅ 実装済み |
| モジュール Data State (Redis) | ✅ 実装済み |
| 統合 /auth エンドポイント | ✅ 実装済み |
| 環境別認証設定 | ✅ 実装済み |
| レート制限 | ⏳ Phase 2 |
| サービス間リレー | ⏳ Phase 2 |
| QUIC 対応 | ⏳ Phase 3 |
| 分散リレー | ⏳ Phase 4 |
