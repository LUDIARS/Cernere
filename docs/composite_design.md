# Cernere Composite - 設計書

## 概要

Cernere Composite は、他サービスの **バックエンド** とログイン UI に組み込むための認証パッケージである。

ログイン UI の本流は埋め込み SDK の `<CompositeLogin>` (`@ludiars/cernere-composite/ui`)
である。 パスキー (WebAuthn) の登録 / ログインと、 メールアドレス不要の新規登録
(name のみ / email 任意) はこのカードが持ち、 サービス SPA は自分の backend 経由で
Cernere と往復する `authApi` を渡すだけでよい (後述「埋め込みログイン UI とパスキー」)。

Cernere ホストの `/composite/login` と Cernere 単独フロントの `/login` も同じカードを
描画するだけで、 独自のログインフォームは持たない (`/login` は self モード = authCode を
`POST /api/auth/exchange` で自分のトークンに交換)。 別 eTLD+1 のサービス向けには、
PC では呼び出し元と同じウィンドウで Cernere に遷移し `redirect_uri` に one-time code を
返す / モバイルでは popup を使う `<CompositePasskeyPopup>` も残しており、 その場合の
WebAuthn ceremony は Cernere origin 上で実行する。
サービス起動時に Cernere にプロジェクト認証 (WebSocket) を行い、
ユーザー認証をバックエンド経由で仲介する。

**Frontend は Cernere に直接接続しない。**

### 背景と動機

- 各サービスで認証ロジックを実装する負担を排除する
- JWT リレー方式は SPA 統一や Tauri デスクトップ対応で取り回しが難しい
- Frontend → Backend → Cernere のフローで、サービスのバックエンドが認証の仲介者となる

## パッケージ構成

```
@ludiars/cernere-composite    ← バックエンド SDK + 埋め込み React ログイン UI
  packages/composite/
    src/
      index.ts                 ← 公開 API (backend)
      types.ts                 ← 型定義 (CompositeConfig, ExchangeResult)
      composite.ts             ← CernereComposite クラス
      ui/
        index.ts               ← 公開 API (`@ludiars/cernere-composite/ui`)
        CompositeLogin.tsx     ← 埋め込みログインカード (認証 UI の本流)
        auth-api.ts            ← authApi 契約 (password + passkey 4 メソッド)
        usePasskeyLogin.ts     ← パスキー ログイン ceremony (自動起動・single-flight)
        passkey-signup.ts      ← パスキー 新規登録 ceremony (email 任意)
        PasskeyLoginSection.tsx← login タブのパスキー再試行導線
        login-labels.ts        ← 文言 (i18n 上書き可)
        login-styles.ts        ← 共有スタイル
        CompositePasskeyPopup.tsx ← Cernere origin で ceremony する popup 版 (別 eTLD+1 向け)
        device-fingerprint.ts  ← password 経路の本人確認用 fingerprint

依存:
  @ludiars/cernere-service-adapter  ← WebSocket 接続・プロジェクト認証
  @simplewebauthn/browser           ← WebAuthn (navigator.credentials) ラッパ
```

Cernere 自身のフロント (`frontend/`) は publish 済みパッケージではなく、 vite alias +
tsconfig paths で `packages/composite/src/ui` を直接取り込む。 `/login` と
`/composite/login` はこのカードを描画するだけで、 通信は
`frontend/src/lib/composite-auth-adapter.ts` (REST + composite WS) が担う。

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
    | location.assign(url) ------|------ same window -------------->| /composite/login
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

## 埋め込みログイン UI (`<CompositeLogin>`) とパスキー

`@ludiars/cernere-composite/ui` の `<CompositeLogin>` はサービス SPA に埋め込むログイン
カード。 実通信は持たず、 利用側が渡す `authApi` に委譲する (CORS を避けるため通常は
サービス backend → project WS → Cernere)。

### authApi 契約

```typescript
interface CompositeAuthApi {
  login(params: { email; password; device? }): Promise<CompositeAuthResponse>;
  register(params: { name; email?; password?; device? }): Promise<CompositeAuthResponse>;
  mfaVerify?(...); deviceVerify?(...); deviceResend?(...);

  // ── パスキー (4 つ揃えて渡す。 一部だけだと起動時に例外 = 設定不備を無言にしない) ──
  passkeyLoginBegin(params: { email? }): Promise<{ options; challengeOwner }>;
  passkeyLoginFinish(params: { challengeOwner; response }): Promise<CompositeAuthResponse>;
  passkeySignupBegin(params: { name; email? }): Promise<{ signupId; options }>;
  passkeySignupFinish(params: { signupId; response }): Promise<CompositeAuthResponse>;
}
```

- passkey 4 メソッドがあると: login タブで usernameless ceremony を自動起動 (1 マウント 1 回、
  single-flight)、 register タブは「パスキーでアカウント作成」 (name のみ必須) が第一候補、
  email / password は任意 (パスワード登録を選ぶときだけ両方必須)。
- 無いと: 従来どおり email / password のみ。 既存の利用側 (Schedula / Actio) は変更なしで動く。
- props: `passkeyOnly` (パスワード導線と fingerprint 収集を出さない)、 `passkeyAutoStart`
  (送信先検証などが決着してから true にする)、 `initialMode`、 `onModeChange`、 `labels`。

### サービス backend の中継 (project WS)

既存の `auth.login` / `auth.register` プロキシ (Actio の `/api/auth/cernere/*`) と同じ経路で、
project WS の `module_request` を中継する。

```json
{ "type": "module_request", "module": "auth",
  "action": "passkey-login-begin",          // | passkey-login-finish | passkey-signup-begin | passkey-signup-finish
  "payload": { "...ブラウザから受けた body..." } }
```

`module_response.payload` をそのままブラウザへ返す (begin → `{ options, ... }`、 finish → `{ authCode }`)。

未認証 ceremony (signup / usernameless login) のレート制限は、認証済み project WS に
bind された projectKey 単位で行う。サービス申告の接続元 IP は信頼境界に使わない。

### origin / RP ID の前提

WebAuthn の ceremony は「ページを開いている origin」 で実行される。 埋め込み先サービスの
origin を `CERNERE_COMPOSITE_ALLOWED_ORIGINS` に登録すると、 Cernere はそれを WebAuthn の
expectedOrigin に合流させる (`server/src/auth/webauthn-origins.ts`)。 `WEBAUTHN_RP_ID` は
それら全 origin の registrable suffix である必要がある (例: RP ID `example.com`、 サービス
`app.example.com`)。 別 eTLD+1 のサービスは埋め込みではなく `<CompositePasskeyPopup>`
(Cernere origin で ceremony) を使う。 開発時は全て `localhost` なのでポートが違っても動く。
