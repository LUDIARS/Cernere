# Cernere

汎用認証プラットフォーム & データリレーサーバー。複数の認証方式（OAuth / パスワード / MFA）、組織・チーム管理、プロジェクトの永続化、および WebSocket ベースのリアルタイムメッセージリレーを提供します。

> 📖 **ドキュメントサイト**: サービス概要・ドメイングラフ・API リファレンス（トグル展開）・仕様レビューを GitHub Pages で公開しています。ソースは [`site/`](site/)（[README](site/README.md)）。`main` への push で自動デプロイされます。

## セットアップ

設定・起動手順は用途別に [`spec/setup/`](spec/setup/) にまとめてある:

- [サーバを起動する](spec/setup/server-bootstrap.md) / [Excubitor Vault 秘密管理](spec/setup/vault-secrets.md) / [PASETO 署名鍵](spec/setup/paseto-keys.md) / [サービス登録](spec/setup/service-registration.md)
- 全設定キー: [spec/setup/config-reference.md](spec/setup/config-reference.md)

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
| Web サーバー | TypeScript / uWebSockets.js |
| データベース | PostgreSQL 17 (Drizzle ORM) |
| セッション管理 | Redis 7 (ioredis / TTL 7 日) |
| 認証 | GitHub OAuth / Google OAuth / パスワード (bcrypt) |
| MFA | TOTP / SMS (AWS SNS) / Email (AWS SES) |
| JWT | アクセストークン (60 分) / リフレッシュトークン (30 日) |
| フロントエンド | React 19 / React Router 7 / TanStack Query / TypeScript / Vite |

## プロジェクト構成

```
├── server/                # TypeScript バックエンド (uWebSockets.js)
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
│   └── env-cli/           # 他リポ向け互換 CLI
├── frontend/              # React フロントエンド
├── migrations/            # SQL マイグレーション
├── docs/                  # 設計ドキュメント
├── spec/                  # セキュリティ仕様
├── docker-compose.yaml           # 本番 + dev profile (DB 外部)
└── docker-compose.standalone.yaml # All-in-One 用 (DB 内蔵)
```

## セットアップ

### 依存インストール

clone 直後・`git worktree add` 直後は、まずルートで bootstrap を実行する:

```bash
npm run bootstrap
```

`lib/vestigium` は git submodule で、 server が `file:../lib/vestigium` で参照している。
submodule が空のまま `npm ci` すると解決に失敗し、 submodule を取得しただけでも
vestigium の `prepare` が `npx tsc` を解決できずに失敗する。 bootstrap は
「submodule 取得 → vestigium ビルド → ルート・server・frontend・bootstrap 対象 package を install」を
正しい順序で実行する。

依存を個別に入れ直す場合は bootstrap 後に:

```bash
cd server && npm install
cd frontend && npm install
```

> パッケージマネージャは **npm に統一**している (lockfile は `package-lock.json` のみ)。
> pnpm で install すると CI・Revisor と別のツリーになるため使わないこと。

### 環境変数

Cernere の秘密情報は Excubitor の共有 Vault / プロジェクト Vault に保存し、`cernere` の紐付けから起動プロセスへ注入します。`.env.example` は設定名の参考資料です。
Cernere サーバは `.env` の生成・読み込みや外部 secret store への直接取得を行いません。必須値が不足すると変数名だけを示して起動を停止します。

運用スクリプトは Excubitor が動いている PC で、そのまま実行できます。管理 endpoint の `EXCUBITOR_URL`（または明示 `EXCUBITOR_PORT`）を設定すると、secret-agent 経由で不足する環境変数を補います。既存値は保持し、`.env` は不要です。agent token の解決順序と対象 CLI は [運用手順](spec/setup/vault-secrets.md#運用スクリプトの環境補完) を参照してください。

## 起動方法

Excubitor のサービス操作で `cernere` と `cernere-frontend` を起動します。定義は `excubitor.catalog.yaml`、PostgreSQL / Redis は既存インフラを利用します。
`dev` / `dev:server` / `dev:front` は注入済み環境向けの内部コマンドです。`env:gen` や `dotenv-cli` を起動前に呼びません。

- [起動設定](spec/setup/server-bootstrap.md)
- [Vault の保存・紐付けと project secret CLI](spec/setup/vault-secrets.md)
- [OAuth・署名鍵等の設定一覧](spec/setup/config-reference.md)

`packages/env-cli`、`dotenv-cli` と互換 `env:*` コマンドは他リポの利用のために保持しています。利用時は対象リポ自身の設定を使います。Cernere 固有の `env-cli.config.ts` は廃止しました。
従来の compose ファイルも互換資産として残しますが、自動の secret 取得元ではありません。

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

- [セキュリティ設計](spec/interface/security_design.md)
- [認証パッケージ一覧](docs/auth_packages.md)
- [別プロジェクトへの実装ガイド](docs/integration_guide.md)
- [リレー設計](docs/relay_design.md)
- [サービスインターフェース](docs/service_interface.md)

## ライセンス

MIT
