# Cernere Composite - 設計書

## 概要

Cernere Composite は、他サービスに組み込むためのクライアントサイド認証パッケージである。
各サービスは本パッケージを導入することで、Cernere の認証 UI をサービス内に表示し、
ユーザー認証を Cernere に委譲できる。

### 背景と動機

- 各サービスで認証ロジックを実装する負担を排除する
- JWT リレー方式は SPA 統一や Tauri デスクトップ対応で取り回しが難しい
- Google OAuth のように、認証を中央サービスに委譲するモデルを採用する

## パッケージ構成

```
@ludiars/cernere-composite    ← 新規 npm パッケージ
  packages/composite/
    src/
      index.ts                 ← 公開 API
      types.ts                 ← 型定義
      client.ts                ← CernereAuth クラス (認証フロー管理)
      storage.ts               ← セッション保存抽象
      react/
        provider.tsx           ← CernereAuthProvider
        hooks.ts               ← useCernereAuth()
        login-overlay.tsx      ← オーバーレイログイン UI
        login-page.tsx         ← フルページログイン UI
```

## 認証フロー

### 全体図

```
Service App                         Cernere
    |                                   |
    |-- popup or iframe --------------->| /composite/login
    |                                   | (ログイン UI 表示)
    |                                   |
    |                                   | ユーザーが認証
    |                                   |  - Email/Password
    |                                   |  - Google OAuth
    |                                   |  - GitHub OAuth
    |                                   |
    |                                   | 認証成功 -> auth_code 生成
    |<-- postMessage({ authCode }) -----|
    |                                   |
    |-- POST /api/auth/exchange ------->| auth_code -> tokens
    |<-- { accessToken, refreshToken, user }
    |                                   |
    | トークン保存                        |
    | 認証完了                            |
```

### フロー詳細

#### 1. Popup モード (オーバーレイ)

SPA のオーバーレイモーダル内でログインを行う。

1. SDK が `window.open()` で Cernere の `/composite/login?origin=<service_origin>` を開く
2. Cernere がログイン UI を表示 (スタンドアロン、ナビゲーションなし)
3. ユーザーが認証 (Email/Password or OAuth)
4. 認証成功後、Cernere バックエンドが auth_code を生成 (Redis, 60秒 TTL)
5. Cernere フロントエンドが `window.opener.postMessage({ type: 'cernere:auth', authCode }, origin)` を送信
6. SDK が `message` イベントで auth_code を受信
7. SDK が `POST /api/auth/exchange` で auth_code をトークンに交換
8. ポップアップを閉じ、認証完了

#### 2. Redirect モード (フルページ)

ブラウザ全体を使うリダイレクト方式。

1. SDK が現在の URL を `sessionStorage` に保存
2. `window.location.href` を Cernere の `/composite/login?redirect_uri=<callback_url>` に変更
3. Cernere がログイン UI を表示
4. 認証成功後、auth_code を生成
5. `redirect_uri?code=<auth_code>` にリダイレクト
6. サービスのコールバックページで SDK が `code` パラメータを取得
7. SDK が `POST /api/auth/exchange` で交換
8. 元のページに戻る

#### 3. 既存セッションの再利用

1. SDK 初期化時、ストレージからトークンを取得
2. `POST /api/auth/refresh` でトークンの有効性を確認
3. 有効ならログイン UI をスキップ

## Cernere バックエンド追加

### 新規エンドポイント

#### `POST /api/auth/composite/login`

Email/Password ログインの composite 版。トークンの代わりに auth_code を返す。

```
Request:
{
  "email": "user@example.com",
  "password": "password123"
}

Response (200):
{
  "authCode": "550e8400-e29b-41d4-a716-446655440000"
}

Response (200, MFA required):
{
  "mfaRequired": true,
  "mfaToken": "<temporary_jwt>",
  "mfaMethods": ["totp", "email"]
}
```

内部処理:
1. 既存の login ロジックで認証
2. 成功時、accessToken + refreshToken + user を生成
3. auth_code を Redis に保存 (TTL 60秒)
4. auth_code を返す

#### `POST /api/auth/composite/register`

新規登録の composite 版。

```
Request:
{
  "name": "User Name",
  "email": "user@example.com",
  "password": "password123"
}

Response (200):
{
  "authCode": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### `POST /api/auth/composite/mfa/verify`

MFA 検証の composite 版。

```
Request:
{
  "mfaToken": "<temporary_jwt>",
  "method": "totp",
  "code": "123456"
}

Response (200):
{
  "authCode": "550e8400-e29b-41d4-a716-446655440000"
}
```

### OAuth フロー変更

既存の OAuth initiate エンドポイントに `composite` パラメータを追加。

#### `GET /auth/google/login?composite_origin=<origin>`
#### `GET /auth/github/login?composite_origin=<origin>`

- `composite_origin` が指定されている場合、OAuth の `state` に `composite:<origin>` プレフィックスを付与
- OAuth コールバックで `state` を確認し、composite フローの場合:
  - トークンを直接返す代わりに auth_code を生成
  - Cernere フロントエンドの `/composite/callback?code=<auth_code>&origin=<origin>` にリダイレクト

### 既存エンドポイント (変更なし)

- `POST /api/auth/exchange` - auth_code -> tokens (そのまま利用)
- `POST /api/auth/refresh` - トークンリフレッシュ (そのまま利用)
- `GET /api/auth/me` - ユーザー情報取得 (そのまま利用)

## Cernere フロントエンド追加

### 新規ルート

#### `/composite/login`

スタンドアロンのログインページ。アプリシェル (サイドバー等) なしで表示する。

Query パラメータ:
- `origin` - postMessage の送信先オリジン (popup モード)
- `redirect_uri` - リダイレクト先 URL (redirect モード)

機能:
- Email/Password ログイン/登録フォーム
- Google/GitHub OAuth ボタン
- MFA チャレンジ対応
- 認証成功時:
  - popup モード: `window.opener.postMessage()` で auth_code を送信し、自身を閉じる
  - redirect モード: `redirect_uri?code=<auth_code>` にリダイレクト

#### `/composite/callback`

OAuth コールバック後のハンドラページ。

Query パラメータ:
- `code` - auth_code
- `origin` - postMessage の送信先

処理:
1. `window.opener.postMessage({ type: 'cernere:auth', authCode: code }, origin)`
2. `window.close()`

## SDK パッケージ API

### CernereAuth (コアクラス)

```typescript
interface CernereAuthConfig {
  /** Cernere サーバーの URL */
  cernereUrl: string;
  /** 認証成功時のコールバック */
  onAuthSuccess?: (user: CernereUser, tokens: CernereTokens) => void;
  /** 認証失敗時のコールバック */
  onAuthError?: (error: Error) => void;
  /** セッション保存先 (デフォルト: memory) */
  storage?: AuthStorage;
}

class CernereAuth {
  constructor(config: CernereAuthConfig);

  /** Popup でログインを開始 */
  loginWithPopup(): Promise<CernereAuthResult>;

  /** Redirect でログインを開始 */
  loginWithRedirect(callbackUrl?: string): void;

  /** Redirect コールバックの処理 */
  handleRedirectCallback(): Promise<CernereAuthResult | null>;

  /** 現在の認証状態を取得 */
  getUser(): CernereUser | null;
  getAccessToken(): string | null;
  isAuthenticated(): boolean;

  /** トークンをリフレッシュ */
  refreshToken(): Promise<boolean>;

  /** ログアウト */
  logout(): void;
}
```

### AuthStorage (保存抽象)

```typescript
interface AuthStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** ブラウザ localStorage */
function createLocalStorage(): AuthStorage;

/** ブラウザ sessionStorage */
function createSessionStorage(): AuthStorage;

/** メモリ (デフォルト、タブ閉じで消える) */
function createMemoryStorage(): AuthStorage;
```

### React コンポーネント

#### CernereAuthProvider

```tsx
<CernereAuthProvider
  cernereUrl="https://cernere.ludiars.com"
  storage={createLocalStorage()}
  onAuthSuccess={(user) => console.log("Logged in:", user)}
>
  <App />
</CernereAuthProvider>
```

#### useCernereAuth

```typescript
const {
  user,           // CernereUser | null
  isAuthenticated, // boolean
  isLoading,      // boolean
  loginWithPopup, // () => Promise<void>
  loginWithRedirect, // (callbackUrl?) => void
  logout,         // () => void
  accessToken,    // string | null
} = useCernereAuth();
```

#### LoginOverlay

SPA 用オーバーレイモーダル。内部で `loginWithPopup` を使う。

```tsx
<LoginOverlay
  open={showLogin}
  onClose={() => setShowLogin(false)}
  onSuccess={(user) => navigate("/dashboard")}
/>
```

#### LoginPage

フルページ用コンポーネント。内部で `loginWithRedirect` を使う。

```tsx
// /login ルートに配置
<Route path="/login" element={<LoginPage callbackUrl="/auth/callback" />} />
<Route path="/auth/callback" element={<AuthCallback />} />
```

## セキュリティ設計

### postMessage のオリジン検証

- Cernere 側: `origin` パラメータで指定されたオリジンにのみ postMessage を送信
- SDK 側: `message` イベントで `event.origin` が Cernere の URL と一致することを検証

### auth_code の安全性

- UUID v4 (暗号学的ランダム)
- TTL 60秒
- 1回限りの使用 (交換後即削除)
- Redis に保存 (サーバーサイドのみ)

### トークン保存

| プラットフォーム | 推奨保存先 | 設定 |
|-----------------|-----------|------|
| Web SPA | `localStorage` または `sessionStorage` | `createLocalStorage()` / `createSessionStorage()` |
| Tauri | Tauri Store plugin | カスタム `AuthStorage` 実装 |
| SSR | メモリ + HttpOnly Cookie (BFF) | `createMemoryStorage()` + サーバーサイド Cookie |

### CORS

Cernere バックエンドの CORS 設定に、composite を利用するサービスのオリジンを追加する必要がある。

## 利用例

### 基本的な SPA 統合

```tsx
import {
  CernereAuthProvider,
  useCernereAuth,
  LoginOverlay,
  createLocalStorage,
} from "@ludiars/cernere-composite";

function App() {
  return (
    <CernereAuthProvider
      cernereUrl="https://cernere.ludiars.com"
      storage={createLocalStorage()}
    >
      <MainContent />
    </CernereAuthProvider>
  );
}

function MainContent() {
  const { user, isAuthenticated, isLoading } = useCernereAuth();
  const [showLogin, setShowLogin] = useState(false);

  if (isLoading) return <div>Loading...</div>;

  if (!isAuthenticated) {
    return (
      <>
        <button onClick={() => setShowLogin(true)}>ログイン</button>
        <LoginOverlay
          open={showLogin}
          onClose={() => setShowLogin(false)}
        />
      </>
    );
  }

  return <div>Welcome, {user.displayName}!</div>;
}
```

### Redirect モード

```tsx
function LoginButton() {
  const { loginWithRedirect } = useCernereAuth();
  return <button onClick={() => loginWithRedirect("/auth/callback")}>ログイン</button>;
}

function AuthCallback() {
  const { handleRedirectCallback } = useCernereAuth();
  useEffect(() => {
    handleRedirectCallback().then(() => navigate("/"));
  }, []);
  return <div>認証処理中...</div>;
}
```
