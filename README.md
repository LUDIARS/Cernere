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
| Web サーバー | Rust / Axum 0.7 (非同期) |
| データベース | PostgreSQL 17 |
| セッション管理 | Redis 7 (TTL 7 日) |
| 認証 | GitHub OAuth / Google OAuth / パスワード (bcrypt) |
| MFA | TOTP / SMS (AWS SNS) / Email (AWS SES) |
| JWT | アクセストークン (60 分) / リフレッシュトークン (30 日) |
| フロントエンド | React 19 / React Router 7 / TypeScript / Vite |

## プロジェクト構成

```
├── src/
│   ├── main.rs            # アプリケーション初期化
│   ├── routes.rs          # HTTP ルート定義
│   ├── ws.rs              # WebSocket ハンドラー・セッション管理
│   ├── auth.rs            # OAuth・パスワード認証
│   ├── mfa.rs             # TOTP・SMS・Email MFA
│   ├── commands.rs        # WS コマンドディスパッチャー
│   ├── service.rs         # ビジネスロジック
│   ├── db.rs              # データベースクエリ (SQLx)
│   ├── models.rs          # データモデル
│   ├── relay.rs           # メッセージリレー・セッションレジストリ
│   ├── session_state.rs   # Redis 状態管理
│   ├── config.rs          # 環境変数設定
│   ├── app_state.rs       # グローバル状態
│   ├── error.rs           # エラー型
│   ├── redis_session.rs   # Redis クライアント
│   └── env_auth.rs        # 認証設定ビルダー
├── packages/
│   ├── id-service/        # 汎用 Identity Service SDK
│   ├── id-cache/          # Id Service 用キャッシュレイヤー
│   ├── service-adapter/   # 外部サービス用 WebSocket 認証アダプタ
│   └── env-cli/           # Infisical シークレット管理 CLI
├── frontend/              # React フロントエンド
├── migrations/            # SQL マイグレーション
├── docs/                  # 設計ドキュメント
├── spec/                  # セキュリティ仕様
├── env-cli.config.ts              # env-cli プロジェクト設定
├── docker-compose.windows.yaml    # Docker Compose (Windows)
└── docker-compose.linux.yaml      # Docker Compose (Linux / macOS)
```

## セットアップ

環境変数は [Infisical](https://infisical.com) で管理しています。初期セットアップには `env-cli` を使用します。

### 1. 依存インストール

```bash
npm install
```

### 2. Infisical 設定（初回のみ）

```bash
npm run env:setup
npm run env:initialize
```

対話形式で Infisical の認証情報（Project ID / Client ID / Client Secret）を入力します。
`env:initialize` を実行すると、`env-cli.config.ts` で定義されたデフォルトの環境変数が Infisical に登録されます（既存のキーはスキップされます）。
設定は `.env.secrets` に保存されます（gitignore 済み）。

### 3. 開発環境の起動

```bash
npm run env:up
```

Infisical からシークレットを取得し、以下をまとめて起動します:

| サービス | 説明 | ポート |
|---------|------|--------|
| postgres | PostgreSQL 17 | 5432 |
| redis | Redis 7 | 6379 |
| backend | Rust (cargo-watch ホットリロード) | 8080 |
| frontend | Vite dev server (HMR) | 5173 |

OS に応じた docker-compose ファイルが自動選択されます:

| OS | ファイル | ベースイメージ |
|----|---------|---------------|
| Windows | `docker-compose.windows.yaml` | Debian ベース |
| Linux / macOS | `docker-compose.linux.yaml` | Alpine ベース |

データベースのマイグレーションはバックエンド起動時に自動で実行されます。

DB のみ起動したい場合:

```bash
npm run env:up -- -- -d postgres redis
```

## API

> **セキュリティモデル**: 公開エンドポイントは **認証 (`/auth`)** のみです。セッションの確立（WebSocket アップグレード）および現在の状態確認はすべて `/auth` で行われます。データの参照・変更を含む操作は WebSocket セッション経由で実行されます。エンドポイントの詳細は `src/routes.rs` を参照してください。

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
