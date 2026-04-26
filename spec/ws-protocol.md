# WebSocket プロトコル

Cernere は **3 経路** の WebSocket を公開する。すべて uWebSockets.js ベースで、メッセージは JSON テキスト。

| パス | 認証 | 用途 |
|---|---|---|
| `/auth?token=<jwt>` または `?session_id=<id>` | user JWT or session | エンドユーザの常時接続 (操作の認可ゲート) |
| `/ws/project?token=<projectJwt>` | project token (HS256) | 外部サービスのサーバ ↔ Cernere |
| `/auth/composite-ws?ticket=<ticket>` | auth_session ticket | composite ログイン中のデバイス検証ハンドオフ |

## 共通メッセージ型

### Server → Client

```json
{ "type": "connected", "session_id": "...", "user_state": {...} }
{ "type": "ping",      "ts": 1234567890 }
{ "type": "module_response", "request_id": "uuid", "module": "...", "action": "...", "payload": {...} }
{ "type": "error",     "code": "command_error", "message": "...", "request_id": "uuid" }
{ "type": "relayed",   "from_session": "...", "payload": {...} }
```

### Client → Server

```json
{ "type": "pong", "ts": 1234567890 }
{ "type": "module_request", "request_id": "uuid", "module": "...", "action": "...", "payload": {...} }
{ "type": "relay",  "target": "broadcast" | { "user": "..." } | { "session": "..." }, "payload": {...} }
```

## 経路 1: `/auth` (ユーザ WS)

```mermaid
sequenceDiagram
    autonumber
    participant U as ブラウザ
    participant CS as Cernere /auth
    participant SR as SessionRegistry
    participant R as Redis (ustate)

    U->>CS: GET /auth?token=<jwt>
    CS->>CS: resolveWsAuth() — JWT verify or session_id lookup
    alt 認証 OK
        CS->>SR: register(userId, sessionId)
        CS->>R: SET ustate:<userId> = LoggedIn
        CS-->>U: { type:"connected", session_id, user_state }
    else 認証 NG
        CS-->>U: アップグレード後ゲストとして開く<br/>(promoted=false, isGuest=true)
        Note over CS: ゲストは module_request 不可、login のみ
    end

    loop 30 秒間隔
        CS-->>U: { type:"ping", ts }
        U-->>CS: { type:"pong", ts }
        CS->>R: updateLastPing
    end

    U->>CS: { type:"module_request", module, action, payload }
    CS->>CS: dispatch (commands.ts)
    CS-->>U: { type:"module_response", payload }

    U->>CS: { type:"relay", target:"broadcast", payload }
    CS->>SR: 同一 user の他 session に broadcast
```

- ゲスト接続 (token なし) も許容するが、操作可能なコマンドは login 系のみ
- `promoted=true` になるとゲスト → 認証済みに昇格
- close 時に `ustate` を `SessionExpired` に遷移、SessionRegistry から削除

## 経路 2: `/ws/project` (プロジェクト WS)

```mermaid
sequenceDiagram
    autonumber
    participant S as サービス (Schedula 等)
    participant CS as Cernere /ws/project
    participant PR as project-registry (in-memory)
    participant DB as PostgreSQL

    S->>CS: GET /ws/project?token=<projectJwt>
    CS->>CS: verifyProjectToken (HS256)
    CS->>DB: managed_projects.isActive チェック
    CS->>PR: addConnection(projectKey, connectionId, clientId)
    CS-->>S: { type:"connected", connection_id, project_key, client_id }

    loop 30 秒間隔
        CS-->>S: { type:"ping", ts }
        S-->>CS: { type:"pong", ts }
    end

    S->>CS: { type:"module_request", module:"managed_project",<br/>  action:"get_user_data",<br/>  payload:{ userId, columns } }
    CS->>CS: dispatchProjectCommand(projectKey, ...)
    CS->>DB: SELECT FROM project_data_<projectKey>
    CS-->>S: { type:"module_response", payload:{...} }

    S--xCS: 切断
    CS->>PR: removeConnection(projectKey, connectionId)
```

- WS セッションに `projectKey` が bind される。コマンドの payload で他プロジェクトを指定して書き換える攻撃をブロック
- 接続レジストリは in-memory (プロセスローカル)。ダッシュボードの `connectionCount` / `lastConnectedAt` の供給源
- 詳細: [project-connection-registry.md](project-connection-registry.md)

### dispatch 対応コマンド (主要)

| `module.action` | 説明 |
|---|---|
| `profile.get` / `profile.update` | ユーザープロファイル (個人データ単一情報源) |
| `auth.login` / `auth.register` / `auth.mfa-verify` | composite 認証の relay (ブラウザ → サービス → Cernere) |
| `managed_project.get_user_data` / `set_user_data` / `delete_user_data` | 動的テーブルの user データ操作 |
| `managed_project.update_schema` | プロジェクト自身のスキーマ更新 |
| `managed_project.store_oauth_token` 他 | OAuth トークンを Cernere に預ける ([oauth-token-storage.md](oauth-token-storage.md)) |
| `managed_project.verify_token` | peer から渡された project token のリモート検証 ([peer-relay.md](peer-relay.md)) |
| `managed_relay.register_endpoint` 他 | サービス間直接通信の調停 ([peer-relay.md](peer-relay.md)) |

## 経路 3: `/auth/composite-ws` (composite 認証 WS)

```mermaid
sequenceDiagram
    autonumber
    participant U as ブラウザ
    participant CW as Cernere composite-ws
    participant R as Redis (auth_session)
    participant DB as PostgreSQL

    U->>CW: GET /auth/composite-ws?ticket=<ticket>
    CW->>R: GET auth_session:<ticket>
    alt session 存在 + state != "expired"
        CW-->>U: { type:"state", state:"pending_device" }
    else
        CW-->>U: { type:"error", retryable:false, reason:"session expired" }
        CW->>U: ws.end(4401)
    end

    loop 30 秒間隔
        CW-->>U: { type:"ping", ts }
        U-->>CW: { type:"pong", ts }
    end

    U->>CW: { type:"device", payload:{ machine, browser } }
    CW->>CW: identity-verification.checkDevice
    alt trusted
        CW->>DB: users.lastLoginAt 更新
        CW->>CW: ensureUserProjectRow (session.projectKey が存在すれば)
        CW->>R: auth_session.state = "authenticated"
        CW-->>U: { type:"state", state:"authenticated" }
        CW-->>U: { type:"authenticated", authCode }
        CW->>U: ws.end(1000)
    else 未知 → challenge
        CW-->>U: { type:"state", state:"challenge_pending",<br/>  data:{ deviceToken, anomalies, emailMasked } }
        U->>CW: { type:"verify_code", code:"123456" }
        CW->>CW: verifyChallenge → 成功なら trusted_devices INSERT
        CW->>CW: ensureUserProjectRow
        CW-->>U: { type:"authenticated", authCode }
    end
```

- 1 ticket = 1 WS 接続。再接続は同じ ticket で可能
- `ticket` 自体は 10 分 TTL。完了 / 期限切れで Redis から削除
- 詳細: [identity-verification.md](identity-verification.md)

## エラー応答

REST はステータスコードを `400 / 401 / 403 / 404 / 429 / 500` で返す ([server/src/app.ts](../server/src/app.ts) の `classifyError`)。
WS は `{ type:"error", code, message, request_id? }` で返し、致命的エラーは `ws.end(4xxx, reason)` で切断する。

## ping/pong タイムアウト

| 経路 | 間隔 | timeout 動作 |
|---|---|---|
| `/auth` | 30s | uWS `idleTimeout: 120` → 切断、ustate=SessionExpired |
| `/ws/project` | 30s | uWS `idleTimeout: 120` → close → registry から削除 |
| `/auth/composite-ws` | 30s | uWS `idleTimeout: 60` → close (ticket は TTL まで残る) |
