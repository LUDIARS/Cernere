# Cernere 認証 — 別プロジェクトへの実装ガイド

既存の TypeScript/JavaScript プロジェクトに Cernere の認証基盤を組み込む手順を記載します。

---

## 前提条件

- Cernere コアサーバーがデプロイ済み (JWT_SECRET, PostgreSQL, Redis が設定済み)
- Node.js >= 20
- [Hono](https://hono.dev/) を Web フレームワークとして使用 (推奨)

---

## 導入パターン

プロジェクトの規模と要件に応じて 3 つの導入パターンがあります。

| パターン | 対象 | 必要パッケージ |
|---------|------|---------------|
| **A. フルスタック統合** | 自前で認証を完全管理したいサービス | `@cernere/id-service` |
| **B. キャッシュ付き API** | Cernere コアに認証を委譲し、高速検証したいサービス | `@cernere/id-cache` |
| **C. JWT 検証のみ** | 最小構成でトークン検証だけ行いたいサービス | `jsonwebtoken` のみ |

---

## パターン A: フルスタック統合 (`@cernere/id-service`)

自前のデータベースにユーザー・セッションを持ち、認証ルート・ミドルウェアを一括生成するパターンです。

### 1. インストール

```bash
npm install @cernere/id-service hono ioredis bcryptjs jsonwebtoken uuid
```

### 2. リポジトリの実装

`@cernere/id-service` はデータベースへの直接依存を持ちません。各リポジトリインターフェースを実装してください。

#### IdUserRepo (必須)

```typescript
import type { IdUserRepo, CoreUser } from "@cernere/id-service";
import { db } from "./your-db-client";

export const userRepo: IdUserRepo = {
  async findByEmail(email: string): Promise<CoreUser | undefined> {
    return db.query("SELECT * FROM users WHERE email = $1", [email]);
  },

  async findById(id: string): Promise<CoreUser | undefined> {
    return db.query("SELECT * FROM users WHERE id = $1", [id]);
  },

  async findByGoogleId(googleId: string): Promise<CoreUser | undefined> {
    return db.query("SELECT * FROM users WHERE google_id = $1", [googleId]);
  },

  async countAll(): Promise<number> {
    const result = await db.query("SELECT COUNT(*) FROM users");
    return parseInt(result.rows[0].count, 10);
  },

  async create(data: Record<string, unknown>): Promise<void> {
    // data には id, name, email, role, passwordHash, createdAt, updatedAt が含まれる
    // サービス固有フィールドも含まれる場合がある
    await db.query(
      "INSERT INTO users (id, name, email, role, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [data.id, data.name, data.email, data.role, data.passwordHash, data.createdAt, data.updatedAt],
    );
  },

  async update(id: string, data: Record<string, unknown>): Promise<void> {
    // data のキーに応じて動的に UPDATE 文を構築
    const keys = Object.keys(data);
    const sets = keys.map((k, i) => `${toSnakeCase(k)} = $${i + 2}`);
    await db.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $1`,
      [id, ...keys.map((k) => data[k])],
    );
  },
};
```

#### IdSessionRepo (必須)

```typescript
import type { IdSessionRepo, IdSession } from "@cernere/id-service";

export const sessionRepo: IdSessionRepo = {
  async findByRefreshToken(token: string): Promise<IdSession | undefined> {
    return db.query("SELECT * FROM sessions WHERE refresh_token = $1", [token]);
  },

  async create(data: {
    id: string;
    userId: string;
    refreshToken: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void> {
    await db.query(
      "INSERT INTO sessions (id, user_id, refresh_token, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)",
      [data.id, data.userId, data.refreshToken, data.expiresAt, data.createdAt],
    );
  },

  async updateRefreshToken(id: string, refreshToken: string): Promise<void> {
    await db.query("UPDATE sessions SET refresh_token = $1 WHERE id = $2", [refreshToken, id]);
  },

  async deleteById(id: string): Promise<void> {
    await db.query("DELETE FROM sessions WHERE id = $1", [id]);
  },

  async deleteByRefreshToken(token: string): Promise<void> {
    await db.query("DELETE FROM sessions WHERE refresh_token = $1", [token]);
  },
};
```

#### IdUserListRepo (必須)

```typescript
import type { IdUserListRepo, IdUserBasic } from "@cernere/id-service";

export const userListRepo: IdUserListRepo = {
  async findAllBasic(): Promise<IdUserBasic[]> {
    return db.query("SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC");
  },

  async findByIds(userIds: string[]): Promise<IdUserBasic[]> {
    return db.query("SELECT id, name, email, role, created_at FROM users WHERE id = ANY($1)", [userIds]);
  },
};
```

#### その他のリポジトリ (最小実装)

グループ機能やアプリ設定を使わない場合は、空の実装を渡します。

```typescript
import type {
  IdGroupMemberRepo,
  IdGroupRepo,
  IdAppSettingsRepo,
  IdSecretManager,
} from "@cernere/id-service";

export const groupMemberRepo: IdGroupMemberRepo = {
  async findByUserId() { return []; },
  async findByGroupId() { return []; },
};

export const groupRepo: IdGroupRepo = {
  async findById() { return undefined; },
};

export const appSettingsRepo: IdAppSettingsRepo = {
  async findByKey() { return undefined; },
};

// 環境変数ベースの SecretManager
export const secretManager: IdSecretManager = {
  get(key: string) { return process.env[key]; },
  getOrDefault(key: string, defaultValue: string) { return process.env[key] || defaultValue; },
};
```

### 3. 認証ルートのマウント

```typescript
import { Hono } from "hono";
import {
  resolveJwtSecret,
  createAuthRoutes,
  createUserContext,
  requireRole,
} from "@cernere/id-service";
import Redis from "ioredis";
import { userRepo, userListRepo, sessionRepo, groupMemberRepo, groupRepo, appSettingsRepo, secretManager } from "./repos";

const app = new Hono();

// Redis 接続
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// JWT シークレット解決
const jwtSecret = resolveJwtSecret(secretManager);

// 認証ルートを生成・マウント
const authRoutes = createAuthRoutes({
  jwtSecret,
  secretManager,
  getRedis: () => redis,
  userRepo,
  userListRepo,
  sessionRepo,
  appSettingsRepo,
  groupMemberRepo,
  groupRepo,
});

app.route("/api/auth", authRoutes);

// ─── 以下は保護されたルート ─────────────────────────

// 全 API にユーザーコンテキストを付与
app.use("/api/*", createUserContext(jwtSecret, secretManager));

// 管理者限定ルート
app.use("/api/admin/*", requireRole("admin"));

// ルートハンドラでユーザー情報を使用
app.get("/api/dashboard", (c) => {
  const userId = c.get("userId");
  const role = c.get("userRole");
  return c.json({ userId, role });
});

export default app;
```

### 自動生成されるエンドポイント一覧

`createAuthRoutes()` が生成するエンドポイント:

| パス | メソッド | 認証 | 説明 |
|------|---------|------|------|
| `/register` | POST | 不要 | メール/パスワード登録 |
| `/login` | POST | 不要 | ログイン |
| `/refresh` | POST | 不要 | アクセストークン再発行 |
| `/logout` | POST | 不要 | ログアウト |
| `/google` | GET | 不要 | Google OAuth 開始 |
| `/google/callback` | GET | 不要 | Google OAuth コールバック |
| `/me` | GET | Bearer | 現在のユーザー (プラグイン拡張対応) |
| `/users/list` | GET | Bearer | アクセス可能なユーザー一覧 |
| `/users` | GET | Admin | 全ユーザー一覧 |
| `/users/:id/role` | PUT | Admin | ロール変更 |
| `/password` | PUT | Bearer | パスワード変更 |
| `/plugins` | GET | 不要 | 登録済みプラグイン一覧 |

### 4. データベースマイグレーション

最低限必要なテーブル:

```sql
-- ユーザー
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

-- セッション (Redis のフォールバック用)
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  refresh_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## パターン B: キャッシュ付き認証委譲 (`@cernere/id-cache`)

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

## パターン C: JWT 検証のみ (最小構成)

Cernere パッケージに依存せず、JWT の検証だけを行う最小パターンです。

### 1. インストール

```bash
npm install jsonwebtoken
```

### 2. ミドルウェア実装

```typescript
import jwt from "jsonwebtoken";
import { createMiddleware } from "hono/factory";

const JWT_SECRET = process.env.JWT_SECRET!;

interface JwtPayload {
  userId: string;
  role: string;
  iat: number;
  exp: number;
}

// 認証ミドルウェア
const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header("Authorization");

  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "No token provided" }, 401);
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    c.set("userId" as never, payload.userId as never);
    c.set("userRole" as never, payload.role as never);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  await next();
});

// ロールチェック
function requireRole(...roles: string[]) {
  return createMiddleware(async (c, next) => {
    const role = c.get("userRole" as never) as string;
    if (!roles.includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
}
```

### 3. 使用例

```typescript
import { Hono } from "hono";

const app = new Hono();

app.use("/api/*", authMiddleware);
app.use("/api/admin/*", requireRole("admin"));

app.get("/api/profile", async (c) => {
  const userId = c.get("userId");
  // Cernere コアの /api/auth/me を呼んでユーザー情報を取得
  const res = await fetch("http://localhost:8080/api/auth/me", {
    headers: { Authorization: c.req.header("Authorization")! },
  });
  return c.json(await res.json());
});
```

> **注意**: このパターンではトークンの発行・リフレッシュ・ログアウトはすべて Cernere コアサーバーに委譲します。自サービスは検証のみ行います。

---

## プラグインによるプロフィール拡張

サービス固有のユーザー情報 (部署、専攻、カレンダー ID 等) を Cernere の `/me` エンドポイントに追加する仕組みです。パターン A で利用可能です。

### 1. ProfilePlugin の定義

```typescript
import type { ProfilePlugin, CoreUser } from "@cernere/id-service";

const myServicePlugin: ProfilePlugin = {
  serviceId: "my-service",
  serviceName: "My Service",

  // サービス固有フィールドの定義
  profileFields: {
    department: {
      type: "string",
      required: true,
      description: "所属部署",
    },
    employeeNumber: {
      type: "number",
      required: false,
      description: "社員番号",
    },
    preferences: {
      type: "json",
      required: false,
      default: {},
      description: "ユーザー設定",
    },
  },

  // ユーザー一覧で返すフィールド (省略時は全フィールド)
  listFields: ["department"],

  // /me レスポンスのカスタマイズ
  meFields: ["department", "employeeNumber", "preferences"],

  // /me レスポンスの整形 (オプション)
  formatForMe(profileData) {
    return {
      department: profileData.department,
      employeeNumber: profileData.employeeNumber,
      settings: profileData.preferences, // キー名変換の例
    };
  },

  // ライフサイクルフック
  async onUserCreated(user: CoreUser, profileData) {
    console.log(`新規ユーザー作成: ${user.name}`, profileData);
    // 外部システムへの通知等
  },

  async onUserUpdated(user: CoreUser, profileData) {
    console.log(`ユーザー更新: ${user.name}`, profileData);
  },

  async onUserDeleted(userId: string) {
    console.log(`ユーザー削除: ${userId}`);
    // サービス固有データのクリーンアップ
  },
};
```

### 2. プラグインの登録

```typescript
import { pluginRegistry } from "@cernere/id-service";

// プラグインを登録
pluginRegistry.register(myServicePlugin);

// createAuthRoutes に pluginRegistry を渡す
const authRoutes = createAuthRoutes({
  jwtSecret,
  secretManager,
  getRedis: () => redis,
  userRepo,
  userListRepo,
  sessionRepo,
  appSettingsRepo,
  groupMemberRepo,
  groupRepo,
  pluginRegistry, // プラグインレジストリを渡す
});
```

### 3. 登録後の /me レスポンス例

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "田中太郎",
  "email": "tanaka@example.com",
  "role": "general",
  "hasGoogleAuth": true,
  "hasPassword": true,
  "department": "エンジニアリング",
  "employeeNumber": 12345,
  "settings": { "theme": "dark" }
}
```

### 4. ユーザー登録時のプラグインデータ送信

```typescript
// POST /api/auth/register
const body = {
  name: "田中太郎",
  email: "tanaka@example.com",
  password: "securepassword",
  serviceProfiles: {
    "my-service": {
      department: "エンジニアリング",
      employeeNumber: 12345,
    },
  },
};
```

---

## スキーマ自動検出 (Migration Scanner)

既存プロジェクトのスキーマから Cernere コアフィールドとサービス固有フィールドを自動分類するツールです。

### 使い方

```bash
npx tsx packages/id-service/src/migration/cli.ts /path/to/your-project
```

### 検出対象 ORM

| ORM | 検出パターン |
|-----|-------------|
| Drizzle | `pgTable(`, `mysqlTable(`, `sqliteTable(` |
| Prisma | `schema.prisma` の `model User` |
| TypeORM | `@Entity()` デコレータ |

### 出力例

```
===== Cernere Id Service — Schema Scanner =====

リポジトリ: /path/to/your-project

検出されたスキーマ:
  ファイル: src/db/schema.ts
  ORM: drizzle
  テーブル: users
  フィールド:
    [core]             id             — コアユーザーフィールド
    [core]             name           — コアユーザーフィールド
    [core]             email          — コアユーザーフィールド
    [core]             role           — コアユーザーフィールド
    [service-specific] department     — サービス固有フィールド
    [service-specific] employeeNumber — サービス固有フィールド

設定ファイル生成: id-service.config.json
```

生成された `id-service.config.json` をもとに ProfilePlugin を作成できます。

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

## パターン選択チャート

```
認証 DB を自前で持つ?
├─ Yes → ユーザー登録・ログインも自前?
│        ├─ Yes → パターン A (フルスタック統合)
│        └─ No  → パターン A (ルート生成のみ使用)
│
└─ No  → 高トラフィック?
         ├─ Yes → パターン B (キャッシュ付き)
         └─ No  → パターン C (JWT 検証のみ)
```
