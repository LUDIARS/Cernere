# ユーザ認証フロー — サービスを開く (Project Open)

Cernere ダッシュボードで「開く」ボタンを押してから、遷移先サービスでログインが完了するまでの一連の流れ。

ここで扱うのは **ユーザ向け** のフロー (HS256 user token + one-time auth code ハンドオフ) のみ。サービス間直接通信 (PeerAdapter, JWKS / RS256 project token) はこのフローに登場しない。

## シーケンス図

```mermaid
sequenceDiagram
    autonumber
    participant U as ユーザ (ブラウザ)
    participant CF as Cernere SPA
    participant CS as Cernere Server
    participant R as Redis
    participant DB as PostgreSQL
    participant SF as 遷移先サービス SPA

    U->>CF: 「開く」ボタン押下
    CF->>CS: WS: managed_project.open_url<br/>{ projectKey }
    CS->>DB: managed_projects から<br/>frontend_url を取得
    CS->>CS: issueAuthCode()<br/>HS256 access/refresh token を生成
    CS->>DB: refresh_sessions に refreshToken 保存
    CS->>R: SET authcode:<code> TTL=60s<br/>{ accessToken, refreshToken, user }
    CS-->>CF: { url: "<frontend_url>?code=<authCode>" }
    CF->>U: window.open(url, "_blank", "noopener")
    U->>SF: 別タブで遷移先 URL を開く
    SF->>CS: POST /api/auth/exchange<br/>{ code: "<authCode>" }
    CS->>R: GET authcode:<code>
    CS->>R: DEL authcode:<code> (one-time)
    CS-->>SF: 200 OK<br/>{ accessToken, refreshToken,<br/>  user: { id, name, email, role } }
    SF->>SF: history.replaceState で<br/>?code= を URL から削除
    Note over SF,CS: 以降は通常セッションと同等
    SF->>CS: GET /ws?token=<accessToken><br/>または POST /api/auth/refresh
```

## ステップ詳細

| # | エンドポイント / 関数 | 守られる性質 |
|---|---|---|
| 1-2 | `managed_project.open_url` (WS) | 既ログイン user セッション経由 → 認可済み |
| 3-6 | `issueAuthCodeForUserId` (`server/src/auth/auth-code.ts:51`) | refresh token は DB、authCode は Redis に 60秒 TTL |
| 8 | `window.open(url, "_blank", "noopener")` | opener へのアクセスを切る |
| 10-12 | `exchange` (`server/src/http/auth-handler.ts:239`) | **取得即削除** で再利用不可 |
| 13 | `accessToken` | **HS256** で `JWT_SECRET` 署名 (60分有効) |
| 13 | `refreshToken` | UUID (30日、`refresh_sessions` 表に保存) |

## 状態遷移

```mermaid
stateDiagram-v2
    [*] --> AuthCodeIssued: issueAuthCode()<br/>(Redis 60s TTL)
    AuthCodeIssued --> Exchanged: POST /exchange<br/>(取得即 DEL)
    AuthCodeIssued --> Expired: 60秒経過
    Exchanged --> ActiveSession: accessToken (HS256)<br/>+ refreshToken (DB)
    ActiveSession --> ActiveSession: /api/auth/refresh<br/>(refreshToken rotate)
    Expired --> [*]: 401 Unauthorized
    Exchanged --> [*]: コード再利用不可
```

## 設計上のポイント

- **publickey (RS256) はこのフローには登場しない**。
  RS256 / JWKS は `PeerAdapter` (サービス間直接 WS) 専用であり、ユーザ認証経路はすべて HS256 + Redis ハンドオフで完結する。
- authCode 単独では何もできない。
  - 60秒以内に exchange しないと失効
  - 一度 exchange したら破棄 (再利用試行は 401)
- 遷移先サービスは authCode を **保持してはいけない**。
  exchange 直後に `history.replaceState({}, "", location.pathname)` で URL から `?code=` を消すのが定石 (ログ汚染対策)。
- 遷移先 SPA で実際に handoff を実装している例:
  `frontend/src/contexts/AuthContext.tsx:88-91` の `accessToken` / `refreshToken` URL params 受け取り部分が同じ思想 (こちらは OAuth 経由で token を直接 URL に乗せているが、`exchange` 経由なら `?code=` だけが URL に乗る点で安全性が一段高い)。

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `server/src/project/service.ts` `issueProjectOpenUrl()` | frontend_url + authCode を組み立てて返す |
| `server/src/auth/auth-code.ts` `issueAuthCode()` / `issueAuthCodeForUserId()` | token pair 生成 → Redis 格納 |
| `server/src/http/auth-handler.ts` `exchange()` | `/api/auth/exchange` の実体 (one-time GET+DEL) |
| `server/src/auth/jwt.ts` `generateTokenPair()` | HS256 access token + UUID refresh token |
| `server/src/commands.ts` `managedProjectCmd("open_url")` | WS コマンドのディスパッチ |
| `frontend/src/pages/DashboardPage.tsx` `handleOpen()` | `open_url` を呼び window.open する側 |
