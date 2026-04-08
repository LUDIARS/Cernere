# Cernere

汎用認証プラットフォーム & データリレーサーバー。複数の認証方式（OAuth / パスワード / MFA）、組織・チーム管理、プロジェクトの永続化、および WebSocket ベースのリアルタイムメッセージリレーを提供します。

## セキュリティ思想

Cernere は **常時接続セッションの強固な認証** を基盤とするセキュリティモデルを採用しています。

### 原則: 認証済みセッションによる破壊的操作の防御

外部からの破壊的変更を伴うリクエスト（データの削除・上書き・権限変更など）は、認証済みかつ常時接続中のセッションからのみ受け付けます。

- **常時接続 (Always-Connected)**: WebSocket による持続的な接続を維持し、30 秒間隔の ping/pong で生存を検証します。接続が切れたセッションは即座に `SessionExpired` 状態に遷移し、以降の操作は拒否されます。
- **強固な認証 (Strong Authentication)**: JWT トークンまたはセッション ID による認証を接続確立時に必須とし、未認証の接続は即座に拒否します。
- **破壊的操作のブロック**: 認証されていない、またはセッションが無効な状態からの破壊的リクエストはサーバ側で遮断されます。
- **最小権限の原則**: リレーメッセージは同一ユーザのセッション間に制限され、他ユーザへの意図しない影響を防ぎます。
- **操作ログ**: すべての WebSocket コマンドは `operation_logs` テーブルに記録され、完全な監査証跡を提供します。

### 多層防御

```
Layer 1: Cookie / Bearer Token 検証 (401)
Layer 2: Redis セッション TTL チェック (7 日間, 401)
Layer 3: ユーザー状態検証 (LoggedIn 必須, 403)
Layer 4: リソース所有権・ロールチェック (403)
```

## 技術スタック

| 分類 | 技術 |
|------|------|
| Web サーバー | TypeScript / Hono (Node.js) |
| データベース | PostgreSQL 17 (Drizzle ORM) |
| セッション管理 | Redis 7 (ioredis / TTL 7 日) |
| 認証 | GitHub OAuth / Google OAuth / パスワード (bcrypt) |
| MFA | TOTP / SMS (AWS SNS) / Email (AWS SES) |
| JWT | アクセストークン (60 分) / リフレッシュトークン (30 日) |
| フロントエンド | React 19 / React Router 7 / TypeScript / Vite |

## プロジェクト構成

```
├── server/                # TypeScript バックエンド (Hono)
│   └── src/
│       ├── index.ts       # エントリポイント
│       ├── app.ts         # ルーティング + WebSocket
│       ├── config.ts      # 環境変数設定
│       ├── commands.ts    # WS コマンドディスパッチ
│       ├── redis.ts       # Redis クライアント・セッション管理
│       ├── auth/          # 認証 (JWT, OAuth, パスワード)
│       ├── ws/            # WebSocket (セッション, ゲスト, リレー)
│       └── db/            # Drizzle ORM スキーマ + 接続
├── packages/
│   ├── id-service/        # 汎用 Identity Service SDK
│   ├── id-cache/          # Id Service 用キャッシュレイヤー
│   ├── service-adapter/   # 外部サービス用 WebSocket 認証アダプタ
│   └── env-cli/           # Infisical シークレット管理 CLI
├── frontend/              # React フロントエンド
├── migrations/            # SQL マイグレーション
├── docs/                  # 設計ドキュメント
├── spec/                  # セキュリティ仕様
├── env-cli.config.ts      # env-cli プロジェクト設定
├── docker-compose.yaml           # 本番 + dev profile (DB 外部)
└── docker-compose.standalone.yaml # All-in-One 用 (DB 内蔵)
```

## セットアップ

### 依存インストール

```bash
cd server && npm install
cd frontend && npm install
```

### 環境変数

`.env` をプロジェクトルートに作成（`.env.example` を参照）。
[Infisical](https://infisical.com) を使用する場合は `env-cli` で管理可能。

```bash
npm run env:setup        # Infisical 初回設定
npm run env:initialize   # デフォルト値を Infisical に登録
```

## 起動方法

### 1. 開発 (ホットリロード) — Infra の DB を使用

LUDIARS 共有インフラ ([Infra](https://github.com/LUDIARS/Infra)) が起動済みの前提。

```bash
docker compose --profile dev up
```

| サービス | 説明 | ポート |
|---------|------|--------|
| backend-dev | Node.js (tsx watch) | 8080 |
| frontend-dev | Vite dev server (HMR) | 5173 |

DB/Redis は Infra 側 (`DATABASE_URL`, `REDIS_URL` で接続)。

### 2. 本番 (ビルド済みイメージ) — Infra の DB を使用

```bash
docker compose up -d
```

| サービス | 説明 | ポート |
|---------|------|--------|
| backend | Node.js (dist/index.js) | 8080 |
| frontend | nginx (静的配信 + API/WS プロキシ) | 5173 (→80) |

### 3. All-in-One (PostgreSQL + Redis 込み) — 単体運用

Infra なしで Cernere 単体で動かしたい場合。

```bash
# 本番
docker compose -f docker-compose.yaml -f docker-compose.standalone.yaml up -d

# 開発
docker compose -f docker-compose.yaml -f docker-compose.standalone.yaml --profile dev up
```

| サービス | 説明 | ポート |
|---------|------|--------|
| postgres | PostgreSQL 17 | 5432 |
| redis | Redis 7 | 6379 |
| backend / backend-dev | 上記と同じ | 8080 |
| frontend / frontend-dev | 上記と同じ | 5173 |

### 4. ローカル直接起動 (Docker なし)

```bash
# バックエンド
cd server && npm run dev

# フロントエンド (別ターミナル)
cd frontend && npm run dev
```

`DATABASE_URL` と `REDIS_URL` が外部の PostgreSQL / Redis を指していること。

## API

> **セキュリティモデル**: 公開エンドポイントは **認証 (`/auth`)** のみです。セッションの確立（WebSocket アップグレード）および現在の状態確認はすべて `/auth` で行われます。データの参照・変更を含む操作は WebSocket セッション経由で実行されます。エンドポイントの詳細は `server/src/app.ts` を参照してください。

## WebSocket

### 接続

```
GET /auth?token=<jwt>          # 新規接続 (JWT 認証)
GET /auth?session_id=<id>      # 再接続 (セッション ID)
```

### セッション管理

- **Ping 間隔**: 30 秒 (サーバー → クライアント)
- **Pong タイムアウト**: 10 秒
- **セッション TTL**: 7 日間 (Redis)
- タイムアウト時は自動切断し、セッションは `SessionExpired` に遷移

### メッセージプロトコル

**クライアント → サーバー:**

```jsonc
// Pong 応答
{ "type": "pong", "ts": 1234567890 }

// モジュールコマンド
{ "type": "module_request", "module": "organization", "action": "list", "payload": {} }

// メッセージリレー
{ "type": "relay", "target": "broadcast", "payload": { ... } }
```

**サーバー → クライアント:**

```jsonc
// 接続完了
{ "type": "connected", "session_id": "...", "user_state": { ... } }

// Ping
{ "type": "ping", "ts": 1234567890 }

// 状態変更通知
{ "type": "state_changed", "user_state": { ... } }

// コマンド応答
{ "type": "module_response", "module": "organization", "action": "list", "payload": [...] }

// リレーメッセージ受信
{ "type": "relayed", "from_session": "...", "payload": { ... } }
```

### リレーターゲット

| ターゲット | 説明 |
|-----------|------|
| `"broadcast"` | 自身の他セッション全てに送信 |
| `{"user": "<user_id>"}` | 特定ユーザーの全セッションに送信 |
| `{"session": "<session_id>"}` | 特定セッションに直接送信 |

### WebSocket モジュール

すべての状態変更操作は WebSocket 経由で実行されます。

#### Organization (`organization`)

| アクション | ペイロード | 権限 |
|-----------|-----------|------|
| `list` | — | 認証済み |
| `get` | `{ organizationId }` | メンバー |
| `create` | `{ name, slug, description? }` | 認証済み |
| `update` | `{ organizationId, name, description? }` | admin / owner |
| `delete` | `{ organizationId }` | owner |

#### Member (`member`)

| アクション | ペイロード | 権限 |
|-----------|-----------|------|
| `list` | `{ organizationId }` | メンバー |
| `add` | `{ organizationId, userId, role? }` | admin / owner |
| `update_role` | `{ organizationId, userId, role }` | admin / owner |
| `remove` | `{ organizationId, userId }` | admin / owner / 自身 |

#### ProjectDefinition (`project_definition`)

| アクション | ペイロード | 権限 |
|-----------|-----------|------|
| `list` | — | 認証済み |
| `get` | `{ id }` | 認証済み |
| `create` | `{ code, name, dataSchema?, commands?, pluginRepository? }` | システム管理者 |
| `update` | `{ id, name, dataSchema?, commands?, pluginRepository? }` | システム管理者 |
| `delete` | `{ id }` | システム管理者 |

#### OrganizationProject (`org_project`)

| アクション | ペイロード | 権限 |
|-----------|-----------|------|
| `list` | `{ organizationId }` | メンバー |
| `enable` | `{ organizationId, projectDefinitionId }` | admin / owner |
| `disable` | `{ organizationId, projectDefinitionId }` | admin / owner |

#### User (`user`)

| アクション | ペイロード | 権限 |
|-----------|-----------|------|
| `get` | `{ userId }` | 同一組織メンバー / 自身 |

## ドキュメント

- [セキュリティ設計](spec/security_design.md)
- [認証パッケージ一覧](docs/auth_packages.md)
- [別プロジェクトへの実装ガイド](docs/integration_guide.md)
- [リレー設計](docs/relay_design.md)
- [サービスインターフェース](docs/service_interface.md)

## ライセンス

MIT
