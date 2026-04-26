# 認証フロー一覧

Cernere がサポートする 5 種類の認証経路。すべて最終的に **HS256 JWT (`JWT_SECRET`)** で署名される。

| 経路 | 入力 | 出力 | 用途 |
|---|---|---|---|
| [user (email/pw)](#1-user-email--password) | email + password | access + refresh | エンドユーザの直接ログイン |
| [user (OAuth)](#2-user-oauth-github--google) | GitHub / Google code | access + refresh | SNS 連携ログイン |
| [project](#3-project-credentials) | client_id + client_secret | project token | サービスのサーバ認証 |
| [tool](#4-tool-client-credentials) | client_id + client_secret | tool token | CLI / API ツール認証 |
| [composite](#5-composite-埋め込みログイン) | email + pw + デバイス本人確認 | one-time authCode | サービス内 SPA 埋め込みログイン |

---

## 1. user (email + password)

```mermaid
sequenceDiagram
    autonumber
    participant U as ブラウザ
    participant CS as Cernere Server
    participant DB as PostgreSQL
    participant R as Redis

    U->>CS: POST /api/auth/login<br/>{ email, password }
    CS->>R: ratelimit:login:<email> (<= 10/15min)
    CS->>DB: SELECT users WHERE email = ?
    CS->>CS: bcrypt.compare(password, hash)
    alt mfaEnabled
        CS-->>U: { mfaRequired: true, mfaMethods }
        U->>CS: POST /api/auth/mfa-verify<br/>{ token, method, code }
    end
    CS->>DB: refresh_sessions に refreshToken INSERT
    CS-->>U: { user, accessToken (HS256), refreshToken }
```

- Rate limit: `login:<email>` で 15 分 10 回
- Token: `accessToken` HS256 60 分、`refreshToken` UUID 30 日
- `users.lastLoginAt` を now() に更新

## 2. user (OAuth: GitHub / Google)

```mermaid
sequenceDiagram
    autonumber
    participant U as ブラウザ
    participant CS as Cernere Server
    participant P as Provider (GitHub/Google)
    participant DB as PostgreSQL
    participant R as Redis

    U->>CS: GET /auth/github/login<br/>または /auth/google/login
    CS->>U: 302 → Provider authorize<br/>+ Set-Cookie: cernere_csrf_state
    U->>P: ログイン + 同意
    P->>U: 302 → /auth/<provider>/callback?code&state
    U->>CS: GET callback
    CS->>CS: csrf state を Cookie と照合
    CS->>P: token exchange (code → access_token)
    CS->>P: GET /user (profile)
    CS->>DB: users UPSERT (githubId / googleId 一致で update)
    alt composite mode (state="composite:<origin>:<uuid>")
        CS->>R: SET authcode:<code> TTL 60s<br/>{ accessToken, refreshToken, user }
        CS-->>U: 302 → /composite/callback?code&origin
    else 通常モード
        CS->>R: SET session:<id> TTL 7d (OAuth session)
        CS-->>U: 302 → /<br/>+ Set-Cookie: ars_session
    end
```

- CSRF: state パラメータ + Cookie で二重検証
- Composite mode: `state` プリフィクスが `composite:` の場合は authCode 経由で親 SPA に postMessage する
- アカウントリンク: `state="link:<userId>"` で既存ユーザに OAuth ID を後付け追加

## 3. project (client_credentials)

```mermaid
sequenceDiagram
    autonumber
    participant S as 外部サービス (Schedula 等)
    participant CS as Cernere Server
    participant DB as PostgreSQL

    S->>CS: POST /api/auth/login<br/>{ grant_type:"project_credentials",<br/>  client_id, client_secret }
    CS->>CS: ratelimit:project_login:<client_id> (10/5min)
    CS->>DB: SELECT managed_projects WHERE client_id
    CS->>CS: bcrypt.compare(secret, hash)
    CS-->>S: { tokenType:"project",<br/>  accessToken (HS256),<br/>  expiresIn: 3600,<br/>  project: {...} }

    Note over S,CS: 取得した token で /ws/project に接続
    S->>CS: GET /ws/project?token=<projectToken>
    CS->>CS: verifyProjectToken (HS256)
    CS->>DB: managed_projects.isActive チェック
    CS-->>S: WebSocket Open<br/>{ type:"connected", connection_id, project_key, client_id }
```

- Token は HS256 (`JWT_SECRET` 共有)。RS256/JWKS は廃止
- `/ws/project` 接続成立時、メモリレジストリに登録 → ダッシュボード「使用中」バッジが点灯
- WS では `module_request`/`module_response` 形式で `managed_project.*`, `managed_relay.*`, `auth.*` コマンドを呼ぶ

## 4. tool (client_credentials)

```mermaid
sequenceDiagram
    autonumber
    participant T as CLI / Tool
    participant CS as Cernere Server
    participant DB as PostgreSQL

    T->>CS: POST /api/auth/login<br/>{ grant_type:"client_credentials",<br/>  client_id, client_secret }
    CS->>DB: SELECT tool_clients WHERE client_id
    CS->>CS: bcrypt.compare(secret, hash) + isActive
    CS->>DB: UPDATE tool_clients.lastUsedAt
    CS-->>T: { tokenType:"tool",<br/>  accessToken (HS256, scopes claim),<br/>  expiresIn: 3600,<br/>  client }
```

- `tool_clients.scopes` (JSONB) を JWT claim に含める
- 用途: 自動化スクリプト、E2E テスト、運用ツール

## 5. composite (埋め込みログイン)

外部サービスの SPA に Cernere ログイン UI を埋め込むためのフロー。
プロジェクトサーバ経由 (CORS-free) または 直接 REST の 2 経路。

```mermaid
sequenceDiagram
    autonumber
    participant U as エンドユーザ (サービス SPA)
    participant SF as サービス (front)
    participant SS as サービス (server)
    participant CS as Cernere Server
    participant CW as Cernere composite WS
    participant R as Redis

    rect rgba(220,240,255,0.5)
    Note over U,SS: 経路A: サービスサーバ経由 (project_credentials → auth.login)
    U->>SF: フォーム submit (email, password)
    SF->>SS: POST /api/cernere-login (or similar)
    SS->>CS: WS module_request<br/>{ module:"auth", action:"login",<br/>  payload:{email,password} }
    Note over CS: projectKey は WS セッションから自動付与
    CS->>CS: composite auth_session 発行<br/>(projectKey も session に保存)
    CS-->>SS: { ticket, wsPath }
    SS-->>SF: { ticket, wsPath }
    end

    rect rgba(255,240,220,0.5)
    Note over U,CS: 経路B: ブラウザから直接 REST
    U->>CS: POST /api/auth/composite/login<br/>{ email, password }
    CS->>CS: composite auth_session 発行 (projectKey なし)
    CS-->>U: { ticket, wsPath }
    end

    Note over U,CW: 以降は両経路共通
    U->>CW: GET /auth/composite-ws?ticket=<ticket>
    CW->>R: GET auth_session:<ticket>
    CW-->>U: { type:"state", state:"pending_device" }
    U->>CW: { type:"device", payload: { machine, browser } }
    CW->>CW: identity-verification.checkDevice()
    alt 信頼済みデバイス
        CW-->>U: { type:"state", state:"authenticated" }
        CW-->>U: { type:"authenticated", authCode }
    else 未知デバイス → メール確認
        CW-->>U: { type:"state", state:"challenge_pending",<br/>  data:{ deviceToken, anomalies, emailMasked } }
        U->>U: メールで届いたコード入力
        U->>CW: { type:"verify_code", code:"123456" }
        CW->>CW: verifyChallenge() OK → trusted_devices INSERT
        CW-->>U: { type:"authenticated", authCode }
    end

    Note over CW,CS: authCode 発行と同時に projectKey が判明していれば<br/>ensureUserProjectRow → project_data_<key> に user 行確保
```

- `auth_session` Redis TTL: 10 分
- `device_challenge` Redis TTL: 10 分、最大 5 回試行
- `authCode` 発行 → `/api/auth/exchange` で one-time 交換 → `accessToken`/`refreshToken`
- 経路A の `projectKey` は [user-project-row.md](user-project-row.md) の自動 row 初期化に使われる

## 共通: トークン交換 (exchange)

```mermaid
sequenceDiagram
    participant SF as サービス SPA
    participant CS as Cernere Server
    participant R as Redis
    SF->>CS: POST /api/auth/exchange { code }
    CS->>R: GET authcode:<code>
    CS->>R: DEL authcode:<code> (one-time)
    CS-->>SF: { accessToken, refreshToken, user }
```

- 60 秒以内に exchange しないと失効
- 一度 exchange したら破棄 (再利用は 401)

## 共通: refresh

```mermaid
sequenceDiagram
    participant C as クライアント
    participant CS as Cernere Server
    participant DB as PostgreSQL
    C->>CS: POST /api/auth/refresh { refreshToken }
    CS->>DB: SELECT refresh_sessions WHERE refresh_token
    CS->>CS: expiresAt チェック
    CS->>CS: 新しい accessToken/refreshToken 発行
    CS->>DB: refresh_sessions.refresh_token を新値に UPDATE (rotate)
    CS-->>C: { accessToken, refreshToken }
```

- refresh token は使用毎に rotate (使い回し検出のため)
- 期限切れは 401 → ユーザは再ログイン

## 共通: logout

```mermaid
sequenceDiagram
    participant C as クライアント
    participant CS as Cernere Server
    participant DB as PostgreSQL
    C->>CS: POST /api/auth/logout { refreshToken }
    CS->>DB: DELETE refresh_sessions WHERE refresh_token
    CS-->>C: 200 { message }
```

`accessToken` の即時無効化はしない (60 分 TTL で自然失効)。リアルタイム遮断が必要なら WS セッション側を `SessionExpired` に遷移させる ([security_design.md](security_design.md))。
