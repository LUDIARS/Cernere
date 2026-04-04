# Cernere 認証パッケージ一覧

Cernere の認証基盤は、Rust 製コアサーバーと複数の TypeScript パッケージで構成されています。
各パッケージの役割と依存関係を以下に記載します。

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────┐
│  cernere (Rust / Axum)  ← コア認証サーバー            │
│  JWT・OAuth・MFA・セッション管理・WebSocket           │
└──────────────┬──────────────────────────────────────┘
               │ HTTP API
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌─────────────┐
│ id-service  │  │  id-cache   │
│ (認証SDK)   │  │ (キャッシュ) │
└──────┬──────┘  └─────────────┘
       │
       ▼
┌─────────────┐
│    auth     │
│ (互換レイヤー)│
└─────────────┘

┌─────────────┐  ┌──────────────────┐
│  env-cli    │  │ frontend (React) │
│ (シークレット)│  │ (認証 UI)        │
└─────────────┘  └──────────────────┘
```

---

## 1. `cernere` (コアサーバー)

| 項目 | 値 |
|------|-----|
| 言語 | Rust |
| フレームワーク | Axum 0.7 |
| パッケージ名 | `cernere` (Cargo.toml) |
| バージョン | 0.2.0 |

### 概要

認証プラットフォームの中核。すべての認証処理・セッション管理・MFA・WebSocket リレーを担当します。

### 認証機能

| 機能 | 実装 | ファイル |
|------|------|---------|
| パスワード認証 | bcrypt (12 rounds) | `src/auth.rs` |
| JWT | アクセストークン (60分) / リフレッシュトークン (30日) | `src/auth.rs` |
| GitHub OAuth | OAuth 2.0 Authorization Code Flow | `src/auth.rs` |
| Google OAuth | OAuth 2.0 Authorization Code Flow | `src/auth.rs` |
| Redis セッション | Cookie ベース / TTL 7日間 | `src/redis_session.rs` |
| TOTP (MFA) | Google Authenticator / Microsoft Authenticator 対応 | `src/mfa.rs` |
| SMS OTP (MFA) | AWS SNS 経由の 6桁コード (5分有効) | `src/mfa.rs` |
| Email OTP (MFA) | AWS SES 経由の検証コード | `src/mfa.rs` |
| Tool Client 認証 | Client ID + Client Secret (`client_credentials`) | `src/auth.rs` |
| レート制限 | Redis ベース (登録: 5回/10分, ログイン: 10回/15分) | `src/auth.rs` |

### 主な依存クレート

| クレート | 用途 |
|---------|------|
| `jsonwebtoken` | JWT 署名・検証 |
| `bcrypt` | パスワードハッシュ |
| `totp-rs` | TOTP ワンタイムパスワード生成・検証 |
| `aws-sdk-sns` | SMS 送信 |
| `aws-sdk-sesv2` | メール送信 |
| `redis` | セッション管理・レート制限 |
| `sqlx` | PostgreSQL (リフレッシュトークン・ユーザー情報) |

### 必須環境変数

| 変数 | 説明 | 必須 |
|------|------|------|
| `JWT_SECRET` | JWT 署名シークレット | 本番環境で必須 |
| `DATABASE_URL` | PostgreSQL 接続文字列 | はい |
| `REDIS_URL` | Redis 接続文字列 | はい |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth | GitHub 認証を使う場合 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth | Google 認証を使う場合 |
| `AWS_SNS_ENABLED` | SMS MFA を有効化 | いいえ |
| `AWS_SES_ENABLED` | Email MFA を有効化 | いいえ |

---

## 2. `@cernere/id-service`

| 項目 | 値 |
|------|-----|
| パス | `packages/id-service/` |
| バージョン | 0.1.0 |
| エントリポイント | `src/index.ts` |

### 概要

汎用 Identity Service パッケージ。外部の TypeScript/JavaScript プロジェクトが Cernere の認証基盤を利用するための SDK です。JWT 認証、セッション管理、ミドルウェア、プラグイン方式のプロフィール拡張を提供します。

### 提供機能

| モジュール | 説明 | エクスポート |
|-----------|------|-------------|
| **JWT** | JWT シークレットの解決・検証 | `resolveJwtSecret()` |
| **セッション** | セッションストア生成 | `createSessionStore()` |
| **ミドルウェア** | ユーザーコンテキスト抽出・ロールベース認可 | `createUserContext()`, `requireRole()` |
| **ヘルパー** | ユーザー ID・ロール取得 | `getUserId()`, `getUserRole()` |
| **ルート** | 認証エンドポイント生成 | `createAuthRoutes()` |
| **プラグイン** | プロフィール拡張システム | `PluginRegistry`, `pluginRegistry` |
| **マイグレーション** | スキーマ自動検出・設定生成 | `RepoScanner`, `scanAndGenerateConfig()` |

### 主要な型

```typescript
CoreUser         // ユーザー情報
IdSession        // セッションデータ
IdUserRepo       // ユーザーリポジトリインターフェース
IdSessionRepo    // セッションリポジトリインターフェース
IdGroupRepo      // グループリポジトリインターフェース
IdServiceConfig  // サービス設定
SessionStore     // セッションストア
ProfilePlugin    // プロフィールプラグイン
```

### 使用例

```typescript
import {
  resolveJwtSecret,
  createSessionStore,
  requireRole,
  createUserContext,
  createAuthRoutes,
} from "@cernere/id-service";

// JWT シークレット解決
const secret = resolveJwtSecret();

// セッションストア生成
const sessionStore = createSessionStore();

// Hono ミドルウェアとして利用
app.use("/api/*", createUserContext());
app.use("/admin/*", requireRole("admin"));

// 認証ルートを自動生成
const authRoutes = createAuthRoutes({ /* config */ });
```

---

## 3. `@cernere/auth`

| 項目 | 値 |
|------|-----|
| パス | `packages/auth/` |
| バージョン | 0.1.0 |
| エントリポイント | `src/index.ts` |

### 概要

`@cernere/id-service` への**後方互換レイヤー**です。旧パッケージ名 `@cernere/auth` を使用しているプロジェクトが、コード変更なしで `id-service` に移行できるようにするためのラッパーパッケージです。

### 動作

すべてのエクスポートを `@cernere/id-service` に委譲します。独自のロジックは持ちません。

### 互換エイリアス

| 旧名 (`@cernere/auth`) | 新名 (`@cernere/id-service`) |
|------------------------|------------------------------|
| `AuthUser` | `CoreUser` |
| `AuthUserRepo` | `IdUserRepo` |
| `AuthSession` | `IdSession` |
| `AuthSessionRepo` | `IdSessionRepo` |
| `AuthGroupRepo` | `IdGroupRepo` |
| `AuthConfig` | `IdServiceConfig` |

### 移行ガイド

新規プロジェクトでは `@cernere/id-service` を直接使用してください。

```diff
- import { AuthUser, resolveJwtSecret } from "@cernere/auth";
+ import { CoreUser, resolveJwtSecret } from "@cernere/id-service";
```

---

## 4. `@cernere/id-cache`

| 項目 | 値 |
|------|-----|
| パス | `packages/id-cache/` |
| バージョン | 0.1.0 |
| エントリポイント | `src/index.ts` |

### 概要

Id Service のユーザー情報をローカルキャッシュし、JWT 検証 + ユーザー解決を高速化するオプションパッケージです。**なくても動作します** — キャッシュがない場合は毎回 Id Service API を呼びます。

### 提供機能

| エクスポート | 説明 |
|-------------|------|
| `createIdCache()` | キャッシュクライアント生成 |
| `createIdCacheMiddleware()` | Hono ミドルウェア生成 |

### 主要な型

```typescript
IdCacheConfig             // キャッシュ設定 (idServiceUrl 等)
IdCacheClient             // キャッシュクライアント
CachedUser                // キャッシュされたユーザー情報
IdCacheMiddlewareOptions  // ミドルウェアオプション
```

### 使用例

```typescript
import { createIdCache } from "@cernere/id-cache";

const cache = createIdCache({
  idServiceUrl: "http://localhost:8079",
});

// Hono ミドルウェアとして組み込み
app.use("/api/*", cache.middleware());

// ミドルウェア適用後、コンテキストからユーザー情報を取得
// c.get("userId"), c.get("userRole") が利用可能
```

### 導入判断

| 条件 | 推奨 |
|------|------|
| リクエスト頻度が高く低レイテンシが必要 | id-cache を導入 |
| プロトタイプ・小規模サービス | 不要 (id-service のみで十分) |

---

## 5. `@cernere/env-cli`

| 項目 | 値 |
|------|-----|
| パス | `packages/env-cli/` |
| バージョン | 0.1.0 |
| エントリポイント | `dist/cli.js` (CLI) / `dist/index.js` (API) |
| 必須 Node | >= 20 |

### 概要

[Infisical](https://infisical.com) を利用したシークレット管理 CLI ツールです。認証に必要な環境変数 (`JWT_SECRET`, OAuth クライアント情報, AWS 認証情報など) を安全に管理し、`.env` ファイルを自動生成します。

### CLI コマンド

| コマンド | 説明 |
|---------|------|
| `setup` | Infisical の認証情報を対話形式で設定 |
| `test` | Infisical 接続テスト |
| `env` | Infisical → `.env` ファイル生成 |
| `list` | シークレット一覧表示 |
| `get <KEY>` | シークレット取得 |
| `set <KEY> <VALUE>` | シークレット作成 / 更新 |

### プログラマティック API

```typescript
import {
  authenticate,
  fetchSecrets,
  getSecretByKey,
  upsertSecret,
  buildDotenv,
} from "@cernere/env-cli";

// Infisical 認証
const client = await authenticate(config);

// シークレット取得
const secrets = await fetchSecrets(client);

// .env 生成
const result = buildDotenv(secrets);
```

---

## 6. `cernere-frontend` (React フロントエンド)

| 項目 | 値 |
|------|-----|
| パス | `frontend/` |
| バージョン | 0.1.0 |
| フレームワーク | React 19 / React Router 7 / Vite 8 |

### 概要

Cernere 認証プラットフォームの Web フロントエンドです。ユーザー登録・ログイン・MFA 設定・OAuth 連携・プロフィール管理の UI を提供します。

### 認証関連モジュール

| ファイル | 説明 |
|---------|------|
| `src/contexts/AuthContext.tsx` | グローバル認証状態管理 (React Context) |
| `src/lib/api.ts` | 認証 API クライアント (トークン管理・自動リフレッシュ) |

### 認証 API クライアント (`src/lib/api.ts`)

| メソッド | 説明 |
|---------|------|
| `auth.register()` | メール / パスワード登録 |
| `auth.login()` | ログイン (MFA チャレンジ対応) |
| `auth.logout()` | ログアウト |
| `auth.me()` | 現在のユーザー取得 |
| `auth.mfaTotpSetup()` / `Enable()` / `Disable()` | TOTP 設定 |
| `auth.mfaSmsSetup()` / `VerifyPhone()` / `Enable()` / `Disable()` | SMS MFA 設定 |
| `auth.mfaEmailEnable()` / `Disable()` | Email MFA 設定 |
| `auth.mfaSendCode()` | OTP 送信 |
| `auth.mfaVerify()` | OTP 検証 |
| `auth.unlinkProvider()` | OAuth プロバイダー連携解除 |
| `toolClients.create()` / `list()` / `remove()` | Tool Client 管理 |

### トークン管理

- `localStorage` にアクセストークン・リフレッシュトークンを保存
- `Authorization: Bearer <token>` ヘッダーで API リクエスト
- 401 レスポンス時にリフレッシュトークンで自動再取得

---

## パッケージ依存関係

```
@cernere/auth ──────────→ @cernere/id-service
                              ↑
@cernere/id-cache ────────────┘ (Id Service API を呼び出し)

@cernere/env-cli ──→ Infisical (外部サービス)

cernere-frontend ──→ cernere (HTTP API)

cernere (Rust) ──→ PostgreSQL / Redis / GitHub API / Google API / AWS SNS / AWS SES
```

---

## 新規プロジェクトへの導入手順

1. **`@cernere/id-service`** をインストール — JWT 認証・ミドルウェア・ルート生成
2. (オプション) **`@cernere/id-cache`** をインストール — 高トラフィック環境でのキャッシュ
3. **`@cernere/env-cli`** で環境変数を設定 — `JWT_SECRET` 等のシークレット管理
4. コアサーバー (`cernere`) をデプロイ — 認証基盤として稼働

> **注意**: `@cernere/auth` は後方互換のためのみ存在します。新規プロジェクトでは `@cernere/id-service` を直接使用してください。
