# ドメイン taxonomy: cernere

自己調整パイプライン（[domain-retune](./domain-retune.md)）が生成。反復 2 回。
このファイルは生成物。手で編集せず `npm run retune` で再生成する。

## authentication

ユーザ認証の中核。JWT/リフレッシュトークン発行、OAuth (GitHub/Google)、パスワード (bcrypt)、MFA (TOTP/SMS/Email)、パスキー、デバイス検証を扱う多層防御の認証基盤。

- **auth-routes** — ログイン・パスキー・認証 HTTP ルート (server/src/http)  `paths: (^|/)server/src/http/[^/]+$`
- **auth-core** — トークン発行・検証、チャレンジ、デバイス/Bearer 抽出 (server/src/auth)  `paths: (^|/)server/src/auth/[^/]+$, (^|/)server/tests/auth/[^/]+$`
- **crypto** — シークレット暗号化と鍵解決 (server/src/lib/crypto)  `paths: (^|/)server/tests/lib/crypto/[^/]+$, (^|/)server/src/lib/crypto/[^/]+$`
- **service-adapter** — Service-to-service auth adapter: middleware and token verification (createServiceAuthMiddleware, verifyServiceToken, connect) plus its test suite.  `paths: (^|/)packages/service-adapter/src/[^/]+$, (^|/)packages/service-adapter/tests/[^/]+$`

## session-relay

常時接続セッションとリアルタイムメッセージリレー。WebSocket 接続確立・ping/pong 生存検証・SessionExpired 遷移、ゲスト/複合認証ハンドリング、同一ユーザ間リレー、Redis セッション TTL 管理。

- **session-store** — Redis セッション・コマンド実行・アプリ配線 (server/src)  `paths: (^|/)server/src/[^/]+$`
- **ws-dispatch** — WS メッセージ/コマンドディスパッチ、デバイス・検証ハンドラ (server/src/ws)  `paths: (^|/)server/src/ws/[^/]+$`
- **composite-auth** — 複合ログインとフィンガープリント収集 (packages/composite, frontend/src/pages/composite)  `paths: (^|/)frontend/src/pages/composite/[^/]+$, (^|/)packages/composite/src/ui/[^/]+$, (^|/)packages/composite/src/[^/]+$`

## web-frontend

React 19 / React Router 7 ベースの管理 UI。ログイン・ダッシュボード・組織/チーム管理・データオプトアウト画面と、トークン保持・WS クエリ・認証コンテキストのクライアントライブラリ。

- **pages** — ログイン・ダッシュボード・組織・オプトアウト各画面 (frontend/src/pages)  `paths: (^|/)frontend/src/pages/[^/]+$`
- **client-lib** — リクエスト・トークン保持・リフレッシュ・WS フック (frontend/src/lib, hooks)  `paths: (^|/)frontend/src/lib/[^/]+$, (^|/)frontend/src/hooks/[^/]+$`
- **auth-context** — 認証プロバイダと useAuth・ルートガード (frontend/src/contexts)  `paths: (^|/)frontend/src/contexts/[^/]+$`
- **frontend-app** — React frontend shell: routing, auth gating, and layout (App, AppRoutes, RequireAuth, AppLayout).  `paths: (^|/)frontend/src/[^/]+$, (^|/)frontend/src/components/[^/]+$`

## oidc-provider

Cernere を IdP とする OpenID Connect プロバイダ。認可コード発行、トークン交換、approve/deny、userinfo、外部 RP 向けエンドポイントと OIDC クライアント管理。

- **oidc-flow** — 認可生成・トークン交換・承認/拒否・userinfo (server/src/oidc)  `paths: (^|/)server/src/oidc/[^/]+$, (^|/)server/tests/oidc/[^/]+$`
- **oidc-admin-ui** — OIDC クライアント登録・同意画面 (frontend/src/pages/admin, oidc)  `paths: (^|/)frontend/src/pages/admin/[^/]+$, (^|/)frontend/src/pages/oidc/[^/]+$`

## platform-ops

運用基盤。Infisical シークレット管理 CLI、環境設定、操作監査ログ (operation_logs)、認証イベント記録など、プラットフォームの設定・秘密・可観測性を担う。

- **env-cli** — Infisical シークレット管理 CLI コマンド (packages/env-cli)  `paths: (^|/)packages/env-cli/src/[^/]+$`
- **audit-logging** — 認証イベント・ユーザログイン・操作ログ記録 (server/src/logging)  `paths: (^|/)server/src/logging/[^/]+$`
- **id-service-migration** — id-service migration and config tooling (scan, generateConfig, printConfig) run as a standalone CLI.  `paths: (^|/)packages/id-service/src/migration/[^/]+$`
- **ops-tooling** — Server bootstrap and repo-level scripts: environment validation (ensureEnv) and maintenance script entrypoints.  `paths: (^|/)server/src/lib/[^/]+$, (^|/)scripts/[^/]+$, (^|/)server/scripts/[^/]+$`

## project-data

プロジェクトの永続化と管理。ユーザ×プロジェクトの行確保、ユーザデータ設定、ピア要求、スキーマ migration、プロジェクト概要一覧などのデータリレー対象資源を扱う。

- **project-store** — ユーザデータ・ピア要求・スキーマ移行・概要一覧 (server/src/project)  `paths: (^|/)server/src/project/[^/]+$`
- **db-migrations** — Drizzle スキーマと SQL マイグレーション実行 (server/src/db)  `paths: (^|/)server/src/db/[^/]+$`

## identity-sdk

汎用 Identity Service SDK 群。外部サービス向けの認証ルート・トークン生成・キャッシュ・WebSocket 認証アダプタ・プラグイン/プロフィールリポジトリを提供する再利用可能パッケージ。

- **id-service** — 認証ルート・トークン生成・プラグイン・移行 (packages/id-service)  `paths: (^|/)packages/id-service/src/core/[^/]+$`
- **service-adapter** — 外部サービス用 WS 認証ミドルウェア・ピアエンベロープ (packages/service-adapter)  `paths: (^|/)packages/service-adapter/src/peer/[^/]+$, (^|/)packages/service-adapter/src/testing/[^/]+$`
- **id-cache** — Id Service 用ユーザキャッシュと退避 (packages/id-cache)  `paths: (^|/)packages/id-cache/src/[^/]+$`
- **id-service-plugin** — id-service plugin surface that wires profile/opt-out repositories and exposes register/get/list operations.  `paths: (^|/)packages/id-service/src/plugin/[^/]+$`

## demo

Standalone demo application: routes, in-memory ext-data store, and response/DTO models demonstrating the identity and ext-data flows.

- **demo-app** — Standalone demo application: routes, in-memory ext-data store, and response/DTO models demonstrating the identity and ext-data flows.  `paths: (^|/)demo/src/[^/]+$, (^|/)demo/src/routes/[^/]+$, (^|/)demo/src/store/[^/]+$, (^|/)demo/src/models/[^/]+$`

