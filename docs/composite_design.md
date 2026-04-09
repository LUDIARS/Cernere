# Cernere Composite - 設計書

## 概要

Cernere Composite は、他サービスの **バックエンド** に組み込むための認証パッケージである。
サービス起動時に Cernere にプロジェクト認証 (WebSocket) を行い、
ユーザー認証をバックエンド経由で仲介する。

**Frontend は Cernere に直接接続しない。**

### 背景と動機

- 各サービスで認証ロジックを実装する負担を排除する
- JWT リレー方式は SPA 統一や Tauri デスクトップ対応で取り回しが難しい
- Frontend → Backend → Cernere のフローで、サービスのバックエンドが認証の仲介者となる

## パッケージ構成

```
@ludiars/cernere-composite    ← バックエンド用 npm パッケージ
  packages/composite/
    src/
      index.ts                 ← 公開 API
      types.ts                 ← 型定義 (CompositeConfig, ExchangeResult)
      composite.ts             ← CernereComposite クラス

依存:
  @ludiars/cernere-service-adapter  ← WebSocket 接続・プロジェクト認証
```

## 認証フロー

### 全体図

```
Frontend (SPA)                Backend (Hono)                    Cernere Server
    |                            |                                   |
    |                            |== 起動時 WS service_auth ========>|
    |                            |<= service_authenticated =========|
    |                            |                                   |
    | GET /api/auth/login-url -->|                                   |
    |<-- { url }                 |                                   |
    |                            |                                   |
    | window.open(url) ----------|------ popup -------------------->| /composite/login
    |                            |                                   | ユーザー認証
    |<-- postMessage(authCode) --|                                   |
    |                            |                                   |
    | POST /api/auth/exchange -->|                                   |
    |   { authCode }             |-- POST /api/auth/exchange ------>|
    |                            |<-- { accessToken, user } --------|
    |                            |   service_token 発行              |
    |<-- { serviceToken, user } -|                                   |
```

### フロー詳細

#### 1. 起動時: プロジェクト認証

サービスの起動時に `CernereComposite.connect()` を呼び出す。
内部で `CernereServiceAdapter` が Cernere の `/ws/service` に WebSocket 接続し、
`service_auth` メッセージで認証する。

必要なシークレット:
- `CERNERE_URL` — Cernere の HTTP URL
- `CERNERE_SERVICE_CODE` — サービスコード (例: "schedula")
- `CERNERE_SERVICE_SECRET` — サービスシークレット
- `JWT_SECRET` — service_token 署名用

#### 2. ログイン URL 取得

Frontend が `GET /api/auth/login-url?origin=<origin>` を呼ぶ。
Backend が `CernereComposite.getLoginUrl(origin)` で Cernere の
`/composite/login?origin=<origin>` URL を返す。

#### 3. Popup ログイン

Frontend がその URL を `window.open()` で開く。
Cernere のログイン UI (Email/Password + Google/GitHub OAuth) が表示される。
認証成功後、Cernere が `postMessage({ type: "cernere:auth", authCode })` を送信。

#### 4. auth_code 交換 (Backend 経由)

Frontend が受け取った `authCode` を `POST /api/auth/exchange` で Backend に送信。
Backend が `CernereComposite.exchange(authCode)` を呼び出し:
1. Cernere の `/api/auth/exchange` に auth_code を送信
2. Cernere から `accessToken`, `refreshToken`, `user` を受信
3. `service_token` (HMAC-SHA256 JWT) を発行
4. Frontend に `{ serviceToken, user }` を返す

以降、Frontend は `serviceToken` を Bearer トークンとしてサービスの API に送信する。

## SDK API

### CernereComposite

```typescript
class CernereComposite {
  constructor(config: CompositeConfig, callbacks?: ServiceAdapterCallbacks);

  /** Cernere に WebSocket 接続 (プロジェクト認証) */
  connect(): void;

  /** 切断 */
  disconnect(): void;

  /** 接続済みか */
  get connected(): boolean;

  /** ユーザーが revoke されているか */
  isRevoked(userId: string): boolean;

  /** Cernere Composite ログイン URL を生成 */
  getLoginUrl(origin: string): string;

  /** auth_code → service_token 交換 */
  exchange(authCode: string): Promise<ExchangeResult>;

  /** refreshToken でトークンをリフレッシュ */
  refresh(refreshToken: string): Promise<ExchangeResult | null>;
}
```

### CompositeConfig

```typescript
interface CompositeConfig {
  cernereUrl: string;       // Cernere HTTP URL
  cernereWsUrl: string;     // Cernere WebSocket URL
  serviceCode: string;      // サービスコード
  serviceSecret: string;    // サービスシークレット
  jwtSecret: string;        // service_token 署名用
  tokenExpiresIn?: number;  // service_token 有効期間 (秒, default: 900)
}
```

## セキュリティ設計

### service_token

- HMAC-SHA256 署名の JWT
- サービスの `jwtSecret` で署名 (Cernere とは別の鍵)
- デフォルト有効期間: 15分
- Claims: `sub` (userId), `name`, `email`, `role`, `iss` (serviceCode)

### auth_code

- UUID v4 (暗号学的ランダム)
- TTL 60秒 (Redis)
- 1回限り (交換後即削除)
- Backend 経由でのみ交換可能

### postMessage

- Cernere 側: `origin` パラメータで指定されたオリジンにのみ送信
- Frontend 側: 受信したメッセージの type を検証

## 利用例 (Schedula)

### Backend (src/auth/composite.ts)

```typescript
import { CernereComposite } from "@ludiars/cernere-composite";

const composite = new CernereComposite({
  cernereUrl: "http://localhost:8080",
  cernereWsUrl: "ws://localhost:8080/ws/service",
  serviceCode: "schedula",
  serviceSecret: process.env.CERNERE_SERVICE_SECRET,
  jwtSecret: process.env.JWT_SECRET,
});

composite.connect(); // 起動時に呼ぶ
```

### Backend (auth routes)

```typescript
// GET /api/auth/login-url (認証不要)
app.get("/login-url", (c) => {
  const origin = c.req.query("origin");
  return c.json({ url: composite.getLoginUrl(origin) });
});

// POST /api/auth/exchange (認証不要)
app.post("/exchange", async (c) => {
  const { authCode } = await c.req.json();
  const result = await composite.exchange(authCode);
  return c.json({ serviceToken: result.serviceToken, user: result.user });
});
```

### Frontend (AuthContext)

```typescript
// 1. Backend からログイン URL を取得
const { url } = await fetch("/api/auth/login-url?origin=" + origin).then(r => r.json());

// 2. Popup を開く
const popup = window.open(url);

// 3. postMessage で authCode を受信
window.addEventListener("message", (e) => {
  if (e.data.type === "cernere:auth") {
    // 4. Backend 経由で交換
    fetch("/api/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ authCode: e.data.authCode }),
    });
  }
});
```
