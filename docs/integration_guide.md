# Cernere 認証 — 別プロジェクトへの実装ガイド

既存の TypeScript/JavaScript プロジェクトに Cernere の認証基盤を組み込む手順を記載します。

---

## 前提条件

- Cernere コアサーバーがデプロイ済み (JWT_SECRET, PostgreSQL, Redis が設定済み)
- Node.js >= 20
- [Hono](https://hono.dev/) を Web フレームワークとして使用 (推奨)

---

## 導入方式: キャッシュ付き認証委譲 (`@cernere/id-cache`)

Cernere コアサーバーに認証処理を委譲し、ローカルキャッシュで JWT 検証を高速化するパターンです。ユーザーテーブルは自プロジェクト側に持ちません。

### 1. インストール

```bash
npm install @cernere/id-cache hono jsonwebtoken
```

### 2. キャッシュクライアントの初期化

```typescript
import { createIdCache } from "@cernere/id-cache";

const idCache = createIdCache({
  // Cernere コアサーバーの URL
  idServiceUrl: "http://localhost:8080",

  // JWT シークレット (ローカル検証で高速化。省略時は毎回 API コール)
  jwtSecret: process.env.JWT_SECRET,

  // キャッシュ TTL (秒, デフォルト: 300 = 5分)
  cacheTtlSeconds: 300,

  // 最大キャッシュエントリ数 (デフォルト: 10000)
  maxCacheSize: 10000,
});
```

### 3. ミドルウェアの適用

```typescript
import { Hono } from "hono";
import { createIdCacheMiddleware } from "@cernere/id-cache";

const app = new Hono();

// 認証ミドルウェアを適用
app.use("/api/*", createIdCacheMiddleware({
  idCache,
  jwtSecret: process.env.JWT_SECRET,
  isDev: process.env.NODE_ENV !== "production",
}));

// ミドルウェア適用後のルートでユーザー情報を取得
app.get("/api/data", (c) => {
  const userId = c.get("userId");   // string
  const role = c.get("userRole");   // string
  const user = c.get("user");       // CachedUser (キャッシュ利用時)

  if (userId === "anonymous") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({ message: `Hello ${user?.name}`, userId, role });
});
```

### 4. キャッシュの運用

```typescript
// 特定ユーザーのキャッシュを無効化 (ロール変更時など)
idCache.invalidate(userId);

// 全キャッシュクリア
idCache.clear();

// キャッシュ統計の確認
const stats = idCache.stats();
console.log(`Cache: size=${stats.size}, hits=${stats.hits}, misses=${stats.misses}`);
```

### 認証フロー

```
クライアント                  あなたのサービス              Cernere コア
    │                            │                           │
    │ Authorization: Bearer xxx  │                           │
    │ ─────────────────────────> │                           │
    │                            │ JWT ローカル検証           │
    │                            │ (jwtSecret あり)          │
    │                            │                           │
    │                            │ キャッシュヒット?          │
    │                            │ ├─ Yes → ユーザー返却     │
    │                            │ └─ No                     │
    │                            │   POST /api/auth/verify   │
    │                            │ ─────────────────────────>│
    │                            │ <─────────────────────────│
    │                            │   キャッシュ保存           │
    │                            │                           │
    │ <───── レスポンス ──────── │                           │
```


---

## シークレット管理 (`@cernere/env-cli`)

### セットアップ

```bash
# 1. Infisical の認証情報を設定
npx env-cli setup

# 2. 接続テスト
npx env-cli test

# 3. .env ファイル生成
npx env-cli env
```

### プログラマティック API

```typescript
import { authenticate, fetchSecrets, buildDotenv, type EnvCliConfig } from "@cernere/env-cli";

const config: EnvCliConfig = {
  name: "my-project",
  infraKeys: {
    DATABASE_URL: "postgres://localhost:5432/mydb",
    REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: "",  // Infisical から取得
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  },
};

// Infisical から .env を生成
const bootstrap = loadBootstrap();
const token = await authenticate(bootstrap);
const secrets = await fetchSecrets(bootstrap, token);
const result = buildDotenv(secrets, bootstrap, config);
// result.content に .env の内容が入る
```

---

## フロントエンドとの連携

フロントエンド (React / Vue / その他) から Cernere 認証を利用する基本パターンです。

### トークン管理

```typescript
// ─── トークンの保存 ─────────────────────────────────────
function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("accessToken", accessToken);
  localStorage.setItem("refreshToken", refreshToken);
}

function clearTokens() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
}

// ─── API リクエスト (自動リフレッシュ付き) ─────────────
async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("accessToken");

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // 401 → リフレッシュ試行
  if (res.status === 401) {
    const refreshToken = localStorage.getItem("refreshToken");
    if (!refreshToken) throw new Error("Not authenticated");

    const refreshRes = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!refreshRes.ok) {
      clearTokens();
      throw new Error("Session expired");
    }

    const { accessToken: newAccess, refreshToken: newRefresh } = await refreshRes.json();
    setTokens(newAccess, newRefresh);

    // リトライ
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newAccess}`,
      },
    });
  }

  return res;
}
```

### 認証 API の呼び出し

```typescript
// 登録
const { user, accessToken, refreshToken } = await fetch("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "田中太郎", email: "tanaka@example.com", password: "password123" }),
}).then((r) => r.json());

setTokens(accessToken, refreshToken);

// ログイン
const loginRes = await fetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tanaka@example.com", password: "password123" }),
}).then((r) => r.json());

setTokens(loginRes.accessToken, loginRes.refreshToken);

// 現在のユーザー取得
const me = await fetchWithAuth("/api/auth/me").then((r) => r.json());

// ログアウト
await fetch("/api/auth/logout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
});
clearTokens();
```

### Google OAuth フロー

```typescript
// 1. Google OAuth ページにリダイレクト
window.location.href = "/api/auth/google";

// 2. コールバック後、URL パラメータからトークンを取得
const params = new URLSearchParams(window.location.search);
const accessToken = params.get("accessToken");
const refreshToken = params.get("refreshToken");

if (accessToken && refreshToken) {
  setTokens(accessToken, refreshToken);
  // URL をクリーンアップ
  window.history.replaceState({}, "", window.location.pathname);
}
```

---

## 開発環境でのテスト

開発環境 (`NODE_ENV !== "production"`) では、Bearer トークンの代わりにヘッダーで認証情報を渡せます。

```bash
# ユーザー ID とロールをヘッダーで指定
curl -H "X-User-Id: test-user-id" \
     -H "X-User-Role: admin" \
     http://localhost:3000/api/dashboard
```

> **注意**: この機能は開発環境のみで有効です。本番環境では無視されます。

---

