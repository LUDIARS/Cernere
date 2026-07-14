# Cernere 仕様書

LUDIARS 認証プラットフォーム Cernere の仕様書。AIFormat
[`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
の 7 分類フォルダ（data / faq / feature / interface / plan / setup / test）に整理する。

## 目次

### `feature/` — 機能概要
| ドキュメント | 範囲 |
|---|---|
| [project-management.md](feature/project-management.md) | managed_projects テーブル・YAML 定義・動的テーブル |
| [user-auth-project-open.md](feature/user-auth-project-open.md) | 「開く」 → exchange ハンドオフ詳細 |
| [identity-verification.md](feature/identity-verification.md) | デバイスフィンガープリント + 6 桁コード本人確認 |
| [user-project-row.md](feature/user-project-row.md) | `project_data_<key>` への row 自動初期化トリガ |
| [project-connection-registry.md](feature/project-connection-registry.md) | プロジェクト WS 接続状態 (使用中バッジ) |

### `interface/` — API・外部連携・セキュリティ境界
| ドキュメント | 範囲 |
|---|---|
| [auth-flows.md](interface/auth-flows.md) | 認証経路 5 種 (user/project/tool/composite/oauth) |
| [ws-protocol.md](interface/ws-protocol.md) | WebSocket 3 経路のメッセージプロトコル |
| [peer-relay.md](interface/peer-relay.md) | サービス間直接 WS 通信 (managed_relay + verify_token) |
| [oauth-token-storage.md](interface/oauth-token-storage.md) | OAuth トークンを Cernere で集中管理 (個人データ単一情報源) |
| [security_design.md](interface/security_design.md) | セキュリティ設計思想・脅威モデル・常時接続検証 |

### `setup/` — セットアップ
| ドキュメント | 範囲 |
|---|---|
| [service-registration.md](setup/service-registration.md) | サービス登録手順 |

### `test/` — テスト
| ドキュメント | 範囲 |
|---|---|
| [test-design.md](test/test-design.md) | 種別ごとのテスト設計 (ビルド/ユニット/smoke/統合/WS/マイグレーション/契約) |

### `plan/` — 実装計画書（作業ドキュメント）
| ドキュメント | 範囲 |
|---|---|
| [passkey-default-authentication.md](plan/passkey-default-authentication.md) | **Proposed**: passkey/email/hybrid モード・Device Credential・ローテーション・手動回復設計 |
| [project-authentication.md](plan/project-authentication.md) | **Proposed**: Project公開鍵認証・短命session・ユーザー委譲・peer assertion設計 |
| [commit-plan.md](plan/commit-plan.md) | Issue #49/#63/#64 のコミット計画 |
| [migration-to-typescript.md](plan/migration-to-typescript.md) | Rust → Node.js 移行履歴 |

### `data/` — データスキーマ
| ドキュメント | 範囲 |
|---|---|
| [README.md](data/README.md) | スコープ（Cernere 所有 / 委託データ除外）+ テーブル一覧（ドメイン別） |
| [schema.md](data/schema.md) | 全 21 テーブルの列定義・制約・インデックス・FK |

※ 動的 `project_data_<key>`（他サービス委託データ）は対象外。

---

## クイックリファレンス

### 認証経路の選び方

| 用途 | エンドポイント | 仕様 |
|---|---|---|
| エンドユーザの直接ログイン | `POST /api/auth/login` | [auth-flows.md#user](interface/auth-flows.md) |
| 外部サービス (Schedula 等) のサーバ認証 | `POST /api/auth/login` (`grant_type=project_credentials`) | [auth-flows.md#project](interface/auth-flows.md) |
| CLI / API ツール認証 | `POST /api/auth/login` (`grant_type=client_credentials`) | [auth-flows.md#tool](interface/auth-flows.md) |
| 別サービスへの SSO 遷移 | `managed_project.open_url` (WS) | [user-auth-project-open.md](feature/user-auth-project-open.md) |
| 別サービスに埋め込んだログイン UI | `POST /api/auth/composite/...` または `auth.login` (project WS) | [auth-flows.md#composite](interface/auth-flows.md) |

### トークン署名

| トークン種別 | 署名 | 鍵 | 検証する場所 |
|---|---|---|---|
| user accessToken | HS256 | `JWT_SECRET` | Cernere |
| user refreshToken | UUID (鍵なし) | DB に保存 | Cernere (`refresh_sessions`) |
| project token | **HS256** ※ | `JWT_SECRET` | Cernere only (peer は `verify_token` 経由) |
| tool token | HS256 | `JWT_SECRET` | Cernere |
| MFA token | HS256 | `JWT_SECRET` | Cernere (5min TTL) |
| authCode | UUID (鍵なし) | Redis に保存 (TTL 60s, one-time) | Cernere |

※ 旧 RS256 + JWKS (publickey) 機構は撤去済み。peer 側は [peer-relay.md](interface/peer-relay.md) の `managed_project.verify_token` を round-trip で叩く。

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
