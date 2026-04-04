# Cernere 認証 — 別プロジェクトへの実装ガイド

既存の TypeScript/JavaScript プロジェクトに Cernere の認証基盤を組み込む手順を記載します。

**基本パターンは `@cernere/id-cache` を使ったキャッシュ付き認証委譲です。** ユーザー管理・ログイン・OAuth は Cernere コアサーバーが一元管理し、各サービスはトークン検証とユーザー情報取得のみ行います。

---

## 前提条件

- Cernere コアサーバーがデプロイ済み (JWT_SECRET, PostgreSQL, Redis が設定済み)
- Node.js >= 20
- [Hono](https://hono.dev/) を Web フレームワークとして使用 (推奨)

---

## 基本実装: キャッシュ付き認証委譲 (`@cernere/id-cache`)

Cernere コアサーバーに認証を一元委譲し、ローカルキャッシュで JWT 検証を高速化するパターンです。各サービスはユーザーテーブルを持たず、Cernere が発行したトークンを検証するだけで認証が完了します。

### アーキテクチャ

```
┌───────────┐      ┌──────────────────────┐      ┌──────────────┐
│ クライアント │      │ あなたのサービス        │      │ Cernere コア  │
│ (React等)  │      │ + @cernere/id-cache  │      │ (認証一元管理) │
└─────┬─────┘      └──────────┬───────────┘      └──────┬───────┘
      │                       │                          │
      │ 1. ログイン/登録       │                          │
      │ ─────────────────────────────────────────────────>│
      │ <─────────────────── accessToken + refreshToken ──│
      │                       │                          │
      │ 2. API リクエスト      │                          │
      │  Authorization: Bearer │                          │
      │ ─────────────────────>│                          │
      │                       │ 3. JWT ローカル検証        │
      │                       │ 4. キャッシュヒット?       │
      │                       │ ├─ Yes → ユーザー返却     │
      │                       │ └─ No                    │
      │                       │   5. POST /api/auth/verify│
      │                       │ ─────────────────────────>│
      │                       │ <─────────────────────────│
      │                       │   6. キャッシュ保存        │
      │ <───── レスポンス ──── │                          │
```

**ポイント**: ログイン・登録・OAuth・MFA はすべて Cernere コアが処理します。あなたのサービスは保護された API のトークン検証のみ担当します。

---

### Step 1. インストール

```bash
npm install @cernere/id-cache hono jsonwebtoken
```

### Step 2. キャッシュクライアントの初期化

```typescript
// src/auth.ts
import { createIdCache, type IdCacheClient } from "@cernere/id-cache";

export const idCache: IdCacheClient = createIdCache({
  // Cernere コアサーバーの URL
  idServiceUrl: process.env.CERNERE_URL || "http://localhost:8080",

  // JWT シークレット (Cernere コアと同じ値)
  // 指定するとローカルで JWT を検証でき、キャッシュヒット時は API コール不要
  // 省略すると毎回 Cernere コアの /api/auth/verify を呼ぶ
  jwtSecret: process.env.JWT_SECRET,

  // キャッシュ TTL (秒, デフォルト: 300 = 5分)
  cacheTtlSeconds: 300,

  // 最大キャッシュエントリ数 (デフォルト: 10000)
  maxCacheSize: 10000,
});
```

### Step 3. ミドルウェアの適用

```typescript
// src/app.ts
import { Hono } from "hono";
import { createIdCacheMiddleware } from "@cernere/id-cache";
import { idCache } from "./auth";

const app = new Hono();

// ─── 認証ミドルウェア ──────────────────────────────────
app.use("/api/*", createIdCacheMiddleware({
  idCache,
  jwtSecret: process.env.JWT_SECRET,
  isDev: process.env.NODE_ENV !== "production",
}));
```

ミドルウェア適用後、すべてのルートハンドラで以下のコンテキスト変数が使えます:

| 変数 | 型 | 説明 |
|------|-----|------|
| `c.get("userId")` | `string` | ユーザー ID (未認証時は `"anonymous"`) |
| `c.get("userRole")` | `string` | ロール (`"admin"` / `"group_leader"` / `"general"`) |
| `c.get("user")` | `CachedUser` | キャッシュされたユーザー情報 (キャッシュ利用時のみ) |

### Step 4. ルートハンドラの実装

```typescript
// ─── 認証が必要な API ─────────────────────────────────

// 認証チェックヘルパー
function requireAuth(c: Context) {
  const userId = c.get("userId");
  if (!userId || userId === "anonymous") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;  // 認証OK
}

// ロールチェックヘルパー
function requireRole(c: Context, ...roles: string[]) {
  const err = requireAuth(c);
  if (err) return err;
  const role = c.get("userRole");
  if (!roles.includes(role)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null;
}

// 一般ユーザー向け API
app.get("/api/data", (c) => {
  const err = requireAuth(c);
  if (err) return err;

  const userId = c.get("userId");
  const user = c.get("user");  // CachedUser { id, name, email, role, ... }
  return c.json({ message: `Hello ${user?.name}`, userId });
});

// 管理者限定 API
app.post("/api/admin/settings", (c) => {
  const err = requireRole(c, "admin");
  if (err) return err;

  // 管理者のみの処理
  return c.json({ ok: true });
});

export default app;
```

### Step 5. 完成形 (最小構成)

```typescript
// src/index.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createIdCache } from "@cernere/id-cache";
import { createIdCacheMiddleware } from "@cernere/id-cache";

const app = new Hono();

// 認証キャッシュ
const idCache = createIdCache({
  idServiceUrl: process.env.CERNERE_URL || "http://localhost:8080",
  jwtSecret: process.env.JWT_SECRET,
});

// 全 API に認証ミドルウェアを適用
app.use("/api/*", createIdCacheMiddleware({
  idCache,
  jwtSecret: process.env.JWT_SECRET,
  isDev: process.env.NODE_ENV !== "production",
}));

// 保護された API
app.get("/api/me", (c) => {
  const userId = c.get("userId");
  if (userId === "anonymous") return c.json({ error: "Unauthorized" }, 401);

  const user = c.get("user");
  return c.json({ id: user?.id, name: user?.name, role: user?.role });
});

serve({ fetch: app.fetch, port: 3000 });
```

### 必須環境変数

```bash
# Cernere コアサーバーの URL
CERNERE_URL=http://localhost:8080

# JWT シークレット (Cernere コアと同じ値)
JWT_SECRET=your-jwt-secret

# 環境
NODE_ENV=development
```

---

## キャッシュの運用

### キャッシュ無効化

ユーザーのロール変更や権限更新が発生した場合、キャッシュを手動で無効化します。

```typescript
// 特定ユーザーのキャッシュを無効化
idCache.invalidate(userId);

// 全キャッシュクリア (デプロイ時など)
idCache.clear();
```

### キャッシュ統計

```typescript
const stats = idCache.stats();
console.log(`size=${stats.size}, hits=${stats.hits}, misses=${stats.misses}`);
// ヒット率: hits / (hits + misses)
```

### キャッシュ設定の目安

| ユースケース | `cacheTtlSeconds` | `maxCacheSize` |
|-------------|-------------------|----------------|
| 権限変更が即座に反映される必要がある | 30〜60 | 1000 |
| 一般的な API サーバー | 300 (デフォルト) | 10000 (デフォルト) |
| 読み取り専用サービス | 600〜1800 | 50000 |

### jwtSecret の有無による動作の違い

| 設定 | 動作 | レイテンシ |
|------|------|-----------|
| `jwtSecret` あり + キャッシュヒット | ローカルのみ、API コールなし | ~0ms |
| `jwtSecret` あり + キャッシュミス | Cernere コアに `/api/auth/verify` | ~10-50ms |
| `jwtSecret` なし | 毎回 Cernere コアに問い合わせ | ~10-50ms |

> **推奨**: Cernere コアと同じ `JWT_SECRET` を設定し、ローカル検証を有効にしてください。

---

## フロントエンドとの連携

ログイン・登録・OAuth はすべて Cernere コアサーバーのエンドポイントを直接呼びます。あなたのサービスの API は Cernere が発行したトークンを受け取るだけです。

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
const CERNERE_URL = "http://localhost:8080";  // Cernere コアサーバー
const SERVICE_URL = "http://localhost:3000";  // あなたのサービス

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("accessToken");

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // 401 → Cernere コアでリフレッシュ
  if (res.status === 401) {
    const refreshToken = localStorage.getItem("refreshToken");
    if (!refreshToken) throw new Error("Not authenticated");

    const refreshRes = await fetch(`${CERNERE_URL}/api/auth/refresh`, {
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
      headers: { ...options.headers, Authorization: `Bearer ${newAccess}` },
    });
  }

  return res;
}
```

### 認証 API (Cernere コアを直接呼ぶ)

```typescript
// ─── 登録 ──────────────────────────────────────────────
const { user, accessToken, refreshToken } = await fetch(`${CERNERE_URL}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "田中太郎", email: "tanaka@example.com", password: "password123" }),
}).then((r) => r.json());

setTokens(accessToken, refreshToken);

// ─── ログイン ──────────────────────────────────────────
const loginRes = await fetch(`${CERNERE_URL}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tanaka@example.com", password: "password123" }),
}).then((r) => r.json());

setTokens(loginRes.accessToken, loginRes.refreshToken);

// ─── あなたのサービスの API を呼ぶ (同じトークンを使用) ──
const data = await fetchWithAuth(`${SERVICE_URL}/api/data`).then((r) => r.json());

// ─── ユーザー情報を Cernere コアから取得 ────────────────
const me = await fetchWithAuth(`${CERNERE_URL}/api/auth/me`).then((r) => r.json());

// ─── ログアウト ────────────────────────────────────────
await fetch(`${CERNERE_URL}/api/auth/logout`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
});
clearTokens();
```

### Google OAuth フロー

```typescript
// 1. Cernere コアの Google OAuth ページにリダイレクト
window.location.href = `${CERNERE_URL}/api/auth/google`;

// 2. コールバック後、URL パラメータからトークンを取得
//    (Cernere コアが FRONTEND_URL にリダイレクト + クエリパラメータ付与)
const params = new URLSearchParams(window.location.search);
const accessToken = params.get("accessToken");
const refreshToken = params.get("refreshToken");

if (accessToken && refreshToken) {
  setTokens(accessToken, refreshToken);
  window.history.replaceState({}, "", window.location.pathname);
}
```

---

## 開発環境でのテスト

開発環境 (`NODE_ENV !== "production"`) では、JWT トークンの代わりにヘッダーで認証情報を直接指定できます。

```bash
# ユーザー ID とロールをヘッダーで指定
curl -H "X-User-Id: test-user-id" \
     -H "X-User-Role: admin" \
     http://localhost:3000/api/data
```

> **注意**: この機能は `isDev: true` の場合のみ有効です。本番環境では無視されます。

---

## 応用パターン

基本パターン以外の導入方法です。特殊な要件がある場合に検討してください。

### 応用 A: フルスタック統合 (`@cernere/id-service`)

自前のデータベースにユーザー・セッションを持ち、認証ルート・ミドルウェアを一括生成するパターンです。以下の場合に検討します:

- Cernere コアとは独立したユーザー DB が必要
- 自前でログイン・登録エンドポイントを持ちたい
- プラグインでプロフィール拡張を行いたい

#### インストール

```bash
npm install @cernere/id-service hono ioredis bcryptjs jsonwebtoken uuid
```

#### セットアップ

```typescript
import { Hono } from "hono";
import {
  resolveJwtSecret,
  createAuthRoutes,
  createUserContext,
  requireRole,
  type IdServiceConfig,
} from "@cernere/id-service";
import Redis from "ioredis";

const app = new Hono();
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// SecretManager (環境変数ベース)
const secretManager = {
  get(key: string) { return process.env[key]; },
  getOrDefault(key: string, d: string) { return process.env[key] || d; },
};

const jwtSecret = resolveJwtSecret(secretManager);

// ─── リポジトリの実装が必要 ───────────────────────────
// IdUserRepo, IdUserListRepo, IdSessionRepo,
// IdGroupMemberRepo, IdGroupRepo, IdAppSettingsRepo
// の実装を用意してください (詳細は後述)

const authRoutes = createAuthRoutes({
  jwtSecret,
  secretManager,
  getRedis: () => redis,
  userRepo,        // IdUserRepo の実装
  userListRepo,    // IdUserListRepo の実装
  sessionRepo,     // IdSessionRepo の実装
  appSettingsRepo, // IdAppSettingsRepo の実装
  groupMemberRepo, // IdGroupMemberRepo の実装
  groupRepo,       // IdGroupRepo の実装
});

// 認証エンドポイントをマウント
app.route("/api/auth", authRoutes);

// 保護されたルートにミドルウェア適用
app.use("/api/*", createUserContext(jwtSecret, secretManager));
app.use("/api/admin/*", requireRole("admin"));
```

#### 必須リポジトリインターフェース

| インターフェース | メソッド | 説明 |
|----------------|---------|------|
| `IdUserRepo` | `findByEmail`, `findById`, `findByGoogleId`, `countAll`, `create`, `update` | ユーザー CRUD |
| `IdUserListRepo` | `findAllBasic`, `findByIds` | ユーザー一覧 |
| `IdSessionRepo` | `findByRefreshToken`, `create`, `updateRefreshToken`, `deleteById`, `deleteByRefreshToken` | セッション管理 |
| `IdGroupMemberRepo` | `findByUserId`, `findByGroupId` | グループメンバー (空実装可) |
| `IdGroupRepo` | `findById` | グループ (空実装可) |
| `IdAppSettingsRepo` | `findByKey` | アプリ設定 (空実装可) |

グループ・アプリ設定を使わない場合は空の実装で動作します:

```typescript
const groupMemberRepo = {
  async findByUserId() { return []; },
  async findByGroupId() { return []; },
};
const groupRepo = { async findById() { return undefined; } };
const appSettingsRepo = { async findByKey() { return undefined; } };
```

#### 自動生成されるエンドポイント

| パス | メソッド | 認証 | 説明 |
|------|---------|------|------|
| `/register` | POST | 不要 | メール/パスワード登録 |
| `/login` | POST | 不要 | ログイン |
| `/refresh` | POST | 不要 | アクセストークン再発行 |
| `/logout` | POST | 不要 | ログアウト |
| `/google` | GET | 不要 | Google OAuth 開始 |
| `/google/callback` | GET | 不要 | Google OAuth コールバック |
| `/me` | GET | Bearer | 現在のユーザー (プラグイン対応) |
| `/users/list` | GET | Bearer | アクセス可能なユーザー一覧 |
| `/users` | GET | Admin | 全ユーザー一覧 |
| `/users/:id/role` | PUT | Admin | ロール変更 |
| `/password` | PUT | Bearer | パスワード変更 |
| `/plugins` | GET | 不要 | 登録済みプラグイン一覧 |

#### 必要なデータベーステーブル

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',
  password_hash TEXT,
  google_id TEXT UNIQUE,
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_token_expires_at BIGINT,
  google_scopes JSONB DEFAULT '[]',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  refresh_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### 応用 B: JWT 検証のみ (最小構成)

Cernere パッケージに一切依存せず、JWT の署名検証だけを行う最小パターンです。

```bash
npm install jsonwebtoken
```

```typescript
import jwt from "jsonwebtoken";
import { createMiddleware } from "hono/factory";

const JWT_SECRET = process.env.JWT_SECRET!;

const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "No token provided" }, 401);
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; role: string };
    c.set("userId" as never, payload.userId as never);
    c.set("userRole" as never, payload.role as never);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  await next();
});

// 使用
app.use("/api/*", authMiddleware);

app.get("/api/profile", async (c) => {
  const userId = c.get("userId");
  // ユーザー詳細が必要なら Cernere コアの /api/auth/me を呼ぶ
  const res = await fetch(`${CERNERE_URL}/api/auth/me`, {
    headers: { Authorization: c.req.header("Authorization")! },
  });
  return c.json(await res.json());
});
```

> **注意**: キャッシュがないため、ユーザー情報が必要な場合は毎回 Cernere コアに問い合わせが発生します。小規模サービスやプロトタイプ向けです。

---

## プラグインによるプロフィール拡張 (応用 A 向け)

フルスタック統合パターンでは、サービス固有のユーザー情報を `/me` エンドポイントに追加するプラグイン機構が使えます。

### ProfilePlugin の定義と登録

```typescript
import type { ProfilePlugin, CoreUser } from "@cernere/id-service";
import { pluginRegistry } from "@cernere/id-service";

const myPlugin: ProfilePlugin = {
  serviceId: "my-service",
  serviceName: "My Service",

  profileFields: {
    department: { type: "string", required: true, description: "所属部署" },
    employeeNumber: { type: "number", required: false, description: "社員番号" },
  },

  listFields: ["department"],
  meFields: ["department", "employeeNumber"],

  // ライフサイクルフック (オプション)
  async onUserCreated(user: CoreUser, profileData) {
    console.log(`新規ユーザー: ${user.name}`, profileData);
  },
};

// 登録
pluginRegistry.register(myPlugin);

// createAuthRoutes に渡す
const authRoutes = createAuthRoutes({
  // ... 他の設定
  pluginRegistry,
});
```

### /me レスポンス例

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "田中太郎",
  "email": "tanaka@example.com",
  "role": "general",
  "department": "エンジニアリング",
  "employeeNumber": 12345
}
```

---

## スキーマ自動検出 (Migration Scanner)

既存プロジェクトのスキーマからコアフィールドとサービス固有フィールドを自動分類します。応用 A の導入時に有用です。

```bash
npx tsx packages/id-service/src/migration/cli.ts /path/to/your-project
```

| 対応 ORM | 検出パターン |
|---------|-------------|
| Drizzle | `pgTable(`, `mysqlTable(`, `sqliteTable(` |
| Prisma | `schema.prisma` の `model User` |
| TypeORM | `@Entity()` デコレータ |

出力された `id-service.config.json` をもとに ProfilePlugin を作成できます。

---

## シークレット管理 (`@cernere/env-cli`)

`JWT_SECRET` 等の環境変数を Infisical で安全に管理するための CLI です。

```bash
# 初回セットアップ
npx env-cli setup

# .env ファイル生成
npx env-cli env
```

詳細は [auth_packages.md](./auth_packages.md) を参照してください。

---

## パターン選択チャート

```
新規サービスに Cernere 認証を組み込みたい
│
├─ 認証 DB を自前で持つ必要がある?
│  ├─ Yes → 応用 A: フルスタック統合 (@cernere/id-service)
│  └─ No ─┐
│          │
│          ├─ ★ 基本パターン: キャッシュ付き認証委譲 (@cernere/id-cache)
│          │   ほとんどのケースではこれで十分
│          │
│          └─ 依存パッケージを最小にしたい?
│             └─ Yes → 応用 B: JWT 検証のみ (jsonwebtoken)
```
