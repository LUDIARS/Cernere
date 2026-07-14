# Cernere TypeScript 移行計画

## 背景

Rust (Axum) で構築された Cernere サーバーを TypeScript (Hono) に移行する。

### 移行理由

- AWS SDK のコンパイルがメモリ 16GB+ を要求し、開発環境 (Docker Desktop) でビルドできない
- サーバーサイドを TypeScript に統一し、LUDIARS 全体の技術スタックを簡素化
- Schedula で既に Hono + Node.js + PostgreSQL + Redis の実績がある

### 技術スタック方針

| 領域 | 言語 | 理由 |
|------|------|------|
| **サーバーサイド** | TypeScript | ビルド軽量、npm エコシステム、チーム共通 |
| **クライアントアプリ** | Rust | パフォーマンス、型安全性、ネイティブ配布 |

## 現状分析

### Rust ソースファイル (6,407 行)

| ファイル | 行数 | 責務 | 移行先 |
|---------|------|------|--------|
| `auth.rs` | 1,270 | OAuth, パスワード認証, JWT, ツール認証 | `src/auth/` |
| `db.rs` | 1,172 | PostgreSQL クエリ (SQLx) | `src/db/` (Drizzle ORM) |
| `mfa.rs` | 658 | TOTP, SMS, Email MFA | `src/mfa/` |
| `ws.rs` | 588 | WebSocket セッション, ゲスト接続 | `src/ws/` |
| `models.rs` | 538 | データモデル, レスポンス型 | `src/models/` |
| `service.rs` | 447 | ビジネスロジック (組織, メンバー等) | `src/service/` |
| `routes.rs` | 387 | HTTP ルーティング | `src/routes.ts` |
| `commands.rs` | 294 | WS コマンドディスパッチ | `src/commands.ts` |
| `relay.rs` | 264 | セッション間メッセージリレー | `src/relay.ts` |
| `session_state.rs` | 236 | Redis ステート管理 | `src/session-state.ts` |
| `redis_session.rs` | 135 | Redis クライアント | `src/redis.ts` |
| `main.rs` | 135 | エントリポイント | `src/index.ts` |
| `config.rs` | 84 | 環境変数 | `src/config.ts` |
| `env_auth.rs` | 115 | 認証設定ビルダー | `src/env-auth.ts` |
| `error.rs` | 67 | エラー型 | `src/error.ts` |
| `app_state.rs` | 17 | グローバル状態 | `src/app-state.ts` |

### 依存クレート → npm パッケージ対応

| Rust クレート | npm パッケージ | 備考 |
|--------------|---------------|------|
| `axum` + `tower-http` | `hono` | Web フレームワーク |
| `axum` (ws) | `hono/websocket` or `ws` | WebSocket |
| `sqlx` (postgres) | `drizzle-orm` + `postgres` | ORM |
| `redis` | `ioredis` | Redis クライアント |
| `jsonwebtoken` | `jsonwebtoken` | JWT |
| `bcrypt` | `bcryptjs` | パスワードハッシュ |
| `reqwest` | `fetch` (Node built-in) | HTTP クライアント |
| `uuid` | `crypto.randomUUID()` | UUID 生成 |
| `chrono` | `Date` / `dayjs` | 日時 |
| `serde` / `serde_json` | TypeScript 型 | シリアライズ |
| `aws-sdk-sns` | `@aws-sdk/client-sns` | SMS (プリビルト) |
| `aws-sdk-sesv2` | `@aws-sdk/client-sesv2` | Email (プリビルト) |
| `totp-rs` | `otpauth` | TOTP |
| `dashmap` | `Map` | 並行マップ |
| `tracing` | `console.log` / `pino` | ログ |

### マイグレーション (SQL)

8 ファイルの PostgreSQL マイグレーションはそのまま使用可能。Drizzle ORM のスキーマ定義に変換する。

## 移行アーキテクチャ

```
src/
├── index.ts              # エントリポイント (Hono + @hono/node-server)
├── config.ts             # 環境変数
├── error.ts              # エラー型
├── app-state.ts          # グローバル状態 (db, redis, sessions)
├── routes.ts             # HTTP ルーティング
├── auth/
│   ├── routes.ts         # 認証エンドポイント (register, login, OAuth, MFA)
│   ├── jwt.ts            # JWT 生成・検証
│   ├── password.ts       # bcrypt ハッシュ・検証
│   ├── oauth-google.ts   # Google OAuth フロー
│   ├── oauth-github.ts   # GitHub OAuth フロー
│   └── tool-client.ts    # ツールクライアント認証
├── mfa/
│   ├── totp.ts           # TOTP (Google/Microsoft Authenticator)
│   ├── sms.ts            # SMS MFA (AWS SNS)
│   └── email.ts          # Email MFA (AWS SES)
├── ws/
│   ├── handler.ts        # WebSocket セッションハンドラ
│   ├── guest.ts          # ゲストセッション
│   ├── protocol.ts       # メッセージ型定義
│   └── service-ws.ts     # サービス用 WebSocket
├── commands.ts           # WS コマンドディスパッチ
├── service.ts            # ビジネスロジック (組織, メンバー, プロジェクト)
├── relay.ts              # セッション間メッセージリレー
├── session-state.ts      # Redis ユーザーステート管理
├── db/
│   ├── schema.ts         # Drizzle スキーマ定義
│   ├── connection.ts     # PostgreSQL 接続
│   └── queries.ts        # クエリ関数
├── redis.ts              # Redis クライアント (ioredis)
└── models.ts             # 共通型定義
```

## 移行手順

### Phase 1: プロジェクト基盤 (新規 TypeScript プロジェクト)

1. `package.json` / `tsconfig.json` 作成
2. Hono + @hono/node-server セットアップ
3. Drizzle ORM + PostgreSQL 接続
4. ioredis 接続
5. 既存マイグレーション SQL → Drizzle スキーマ変換
6. 設定 (config.ts) 移植

### Phase 2: 認証コア

1. JWT 生成・検証 (`jsonwebtoken`)
2. パスワード認証 (`bcryptjs`)
3. ユーザー CRUD (DB クエリ)
4. セッション管理 (Redis)
5. REST エンドポイント (register, login, refresh, logout, me)

### Phase 3: OAuth

1. Google OAuth フロー
2. GitHub OAuth フロー
3. アカウントリンク

### Phase 4: WebSocket

1. WebSocket 接続・認証
2. ゲストセッション
3. セッション昇格
4. Ping/Pong
5. コマンドディスパッチ
6. メッセージリレー

### Phase 5: MFA + ツール認証

1. TOTP (otpauth)
2. SMS MFA (@aws-sdk/client-sns)
3. Email MFA (@aws-sdk/client-sesv2)
4. ツールクライアント (client_credentials)

### Phase 6: ビジネスロジック

1. 組織 CRUD
2. メンバー管理
3. プロジェクト定義
4. 組織プロジェクト
5. ユーザー情報
6. サービス管理
7. プロファイル・プライバシー

### Phase 7: 統合・移行

1. Docker Compose 更新 (backend: node:22-alpine)
2. フロントエンドとの結合テスト
3. 既存 Schedula / 他サービスとの互換性確認
4. Rust ソースの削除

## Docker Compose (移行後)

```yaml
backend:
  image: node:22-alpine
  working_dir: /app
  command: npx tsx watch src/index.ts
  volumes:
    - .:/app
    - node_modules:/app/node_modules
```

ビルドなし、ホットリロード対応、メモリ ~256MB。

## リスク

| リスク | 対策 |
|--------|------|
| WebSocket の安定性 | Hono の WebSocket サポートは Node adapter で利用。`ws` ライブラリにフォールバック可能 |
| パフォーマンス低下 | Cernere の負荷は I/O バウンド (DB/Redis)。CPU バウンドではないため影響軽微 |
| 型安全性の低下 | TypeScript strict mode + Zod バリデーション |
| 既存パッケージとの互換 | id-service, id-cache, env-cli は既に TypeScript。変更不要 |
