# Cernere

汎用認証プラットフォーム & データリレーサーバー。OAuth によるユーザー認証、セッション管理、プロジェクトの永続化、および WebSocket ベースのリアルタイムメッセージリレーを提供します。

## セキュリティ思想

Cernere は **常時接続セッションの強固な認証** を基盤とするセキュリティモデルを採用しています。

### 原則: 認証済みセッションによる破壊的操作の防御

外部からの破壊的変更を伴うリクエスト（データの削除・上書き・権限変更など）は、認証済みかつ常時接続中のセッションからのみ受け付けます。具体的には:

- **常時接続 (Always-Connected)**: WebSocket による持続的な接続を維持し、セッションの生存を ping/pong で継続的に検証します。接続が切れたセッションは即座に `SessionExpired` 状態に遷移し、以降の操作は拒否されます。
- **強固な認証 (Strong Authentication)**: JWT トークンまたはセッション ID による認証を接続確立時に必須とし、未認証の接続は即座に拒否します。
- **破壊的操作のブロック**: 認証されていない、またはセッションが無効な状態からの破壊的リクエスト（DELETE、データ変更など）はサーバ側で遮断されます。
- **最小権限の原則**: リレーメッセージは同一ユーザのセッション間に制限され、他ユーザへの意図しない影響を防ぎます。

この思想により、たとえ外部から悪意のあるリクエストが送られても、正当な認証済みセッションを経由しない限り、システムに対する破壊的変更は一切許可されません。

## 技術スタック

- **Rust** (Axum 0.7) — 非同期 Web サーバー
- **PostgreSQL 17** — ユーザー・プロジェクト・設定の永続化
- **Redis 7** — セッション管理 (TTL 7 日)
- **GitHub OAuth 2.0** — 認証

## セットアップ

### 1. 環境変数

```bash
cp .env.example .env
```

`.env` を編集し、GitHub OAuth の Client ID / Secret を設定してください。

```
DATABASE_URL=postgres://cernere:cernere@localhost:5432/cernere
REDIS_URL=redis://127.0.0.1:6379
LISTEN_ADDR=0.0.0.0:8080
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_REDIRECT_URI=http://localhost:5173/auth/github/callback
```

### 2. PostgreSQL・Redis の起動

```bash
docker compose up -d
```

### 3. ビルド・実行

```bash
cargo run
```

データベースのマイグレーションは起動時に自動で実行されます。

## API

### 認証

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/auth/github/login` | GitHub OAuth ログイン開始 |
| GET | `/auth/github/callback` | OAuth コールバック |
| GET | `/auth/me` | 現在のユーザー情報取得 |
| POST | `/auth/logout` | ログアウト |

### ユーザー

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/users/{user_id}` | ユーザー情報取得 |

### プロジェクト

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/projects` | プロジェクト一覧 |
| POST | `/api/projects` | プロジェクト保存 |
| GET | `/api/projects/{project_id}` | プロジェクト読み込み |
| DELETE | `/api/projects/{project_id}` | プロジェクト削除 |

### 設定

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/settings?projectId=...&key=...` | 設定値取得 |
| POST | `/api/settings` | 設定値保存 |
| DELETE | `/api/settings?projectId=...&key=...` | 設定値削除 |
| GET | `/api/settings/all?projectId=...` | 全設定取得 |

## ライセンス

MIT
