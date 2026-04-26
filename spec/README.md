# Cernere 仕様書

LUDIARS 認証プラットフォーム Cernere の機能別仕様書を集約する。

## 目次

| ドキュメント | 範囲 |
|---|---|
| [security_design.md](security_design.md) | セキュリティ設計思想・脅威モデル・常時接続検証 |
| [project-management.md](project-management.md) | managed_projects テーブル・YAML 定義・動的テーブル |
| [auth-flows.md](auth-flows.md) | 認証経路 5 種 (user/project/tool/composite/oauth) |
| [user-auth-project-open.md](user-auth-project-open.md) | 「開く」 → exchange ハンドオフ詳細 |
| [ws-protocol.md](ws-protocol.md) | WebSocket 3 経路のメッセージプロトコル |
| [identity-verification.md](identity-verification.md) | デバイスフィンガープリント + 6 桁コード本人確認 |
| [user-project-row.md](user-project-row.md) | `project_data_<key>` への row 自動初期化トリガ |
| [project-connection-registry.md](project-connection-registry.md) | プロジェクト WS 接続状態 (使用中バッジ) |
| [oauth-token-storage.md](oauth-token-storage.md) | OAuth トークンを Cernere で集中管理 (個人データ単一情報源) |
| [peer-relay.md](peer-relay.md) | サービス間直接 WS 通信 (managed_relay + verify_token) |
| [migration-to-typescript.md](migration-to-typescript.md) | Rust → Node.js 移行履歴 |

## クイックリファレンス

### 認証経路の選び方

| 用途 | エンドポイント | 仕様 |
|---|---|---|
| エンドユーザの直接ログイン | `POST /api/auth/login` | [auth-flows.md#user](auth-flows.md) |
| 外部サービス (Schedula 等) のサーバ認証 | `POST /api/auth/login` (`grant_type=project_credentials`) | [auth-flows.md#project](auth-flows.md) |
| CLI / API ツール認証 | `POST /api/auth/login` (`grant_type=client_credentials`) | [auth-flows.md#tool](auth-flows.md) |
| 別サービスへの SSO 遷移 | `managed_project.open_url` (WS) | [user-auth-project-open.md](user-auth-project-open.md) |
| 別サービスに埋め込んだログイン UI | `POST /api/auth/composite/...` または `auth.login` (project WS) | [auth-flows.md#composite](auth-flows.md) |

### トークン署名

| トークン種別 | 署名 | 鍵 | 検証する場所 |
|---|---|---|---|
| user accessToken | HS256 | `JWT_SECRET` | Cernere |
| user refreshToken | UUID (鍵なし) | DB に保存 | Cernere (`refresh_sessions`) |
| project token | **HS256** ※ | `JWT_SECRET` | Cernere only (peer は `verify_token` 経由) |
| tool token | HS256 | `JWT_SECRET` | Cernere |
| MFA token | HS256 | `JWT_SECRET` | Cernere (5min TTL) |
| authCode | UUID (鍵なし) | Redis に保存 (TTL 60s, one-time) | Cernere |

※ 旧 RS256 + JWKS (publickey) 機構は撤去済み。peer 側は [peer-relay.md](peer-relay.md) の `managed_project.verify_token` を round-trip で叩く。

### Redis キー命名

| キー | TTL | 用途 |
|---|---|---|
| `session:<id>` | 7 日 | OAuth セッション |
| `ustate:<userId>` | 7 日 | ユーザー接続状態 |
| `auth_session:<ticket>` | 10 分 | composite auth 進行中 |
| `device_challenge:<deviceToken>` | 10 分 | 本人確認チャレンジ |
| `authcode:<code>` | 60 秒 | one-time exchange code |
| `mfa:<token>` | 5 分 | MFA challenge state |
| `ratelimit:<key>` | 動的 | レートリミットカウンタ |
