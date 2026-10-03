# Cernere サーバーの起動設定

秘密管理は [vault-secrets.md](vault-secrets.md)、署名鍵は [paseto-keys.md](paseto-keys.md) を参照。
起動順は `server/src/bootstrap.ts` → `ensureEnv()` → `index.ts`。config や接続プールの初期化より前に Vault 注入値を検査します。

## 必須値

全環境で `DATABASE_URL`、`REDIS_URL`、`JWT_SECRET`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_REDIRECT_URI`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`、`FRONTEND_URL` が必要です。空文字・空白だけの値も不足と扱います。
秘密の取得・補完・ランダム鍵生成はしません。不足エラーは変数名だけを列挙します。機能固有の鍵検証は従来どおり config / auth モジュールが行います。

## 起動手順

1. Excubitor Vault に値を保存し、`cernere` の紐付けに必要な名前を追加します。
2. PostgreSQL / Redis の接続先と OAuth redirect URI を設定します。
3. Excubitor から `cernere` と `cernere-frontend` を起動します。定義の正本は `excubitor.catalog.yaml` です。

`npm run dev` / `dev:server` / `dev:front` は注入済み環境向けです。`.env` 生成や dotenv 経由の読み込みは行いません。サービス操作は Excubitor 経由で行います。
`LISTEN_PORT` が待受ポート、`FRONTEND_URL` がブラウザの origin です。`LISTEN_ADDR` は config が読みません。

## 公開エンドポイント

Cernere は**ほぼ `/auth` (認証) 系しか開かない**。データ参照・変更は認証済み WS セッション経由。`server/src/app.ts` で定義されているもの:

| 種別 | パス | 備考 |
|---|---|---|
| REST | `POST /api/auth/:action` | register / login / refresh / logout / verify / exchange / project-token |
| REST | `GET /api/auth/me` | Bearer user token |
| REST | `POST /api/auth/composite/:action` | 埋め込みログイン |
| REST | `POST /api/auth/passkey/:action` | WebAuthn |
| WS | `/auth?token=<jwt>` / `?session_id=<id>` | ユーザーセッション (新規 / 再接続) |
| WS | `/ws/project?token=<projectToken>` | プロジェクト認証経由 |
| WS | `/auth/composite-ws?ticket=<ticket>` | composite 本人確認 |
| GET | `/.well-known/cernere-public-key` | PASETO 公開鍵 (認証不要・キャッシュ可) |
| GET | `/health` | ヘルスチェック |

> `/oauth/*` や `/ws/service` といったパスは**存在しない**。OAuth は `/auth/github/*` `/auth/google/*` のコールバックのみ、サービス WS は `/ws/project`。連携実装で経路を誤らないこと。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `[env-bootstrap] missing Vault-injected env: ...` | Vault の値と `cernere` の紐付けを確認する。値はログへ貼らない。 |
| `JWT_SECRET must be set` | Excubitor Vault から固定の署名鍵を注入する。 |
| port を変えても反映されない | catalog と `LISTEN_PORT` を確認する。 |
