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

## 拠点への導入 (Excubitor bootstrap)

別拠点へは Excubitor の `action=bootstrap` で clone・セットアップします (契約の正本は Castra の `.agents/skills/service-bootstrap/SKILL.md`)。
リポ直下の `excubitor.bootstrap.json` が入口です。

- `scripts/site/setup.mjs` — 引数なし・非対話。実行中の Node と同じ場所の npm を PATH の先頭に置いて、次の 2 段を順に流します。migration は流しません (server 起動時に走る従来どおり)。
  1. `scripts/bootstrap.mjs --server-only` (submodule 取得 → vestigium ビルド → server の install と build)
  2. `scripts/site/build-frontend.mjs` (frontend の `npm ci --include=dev` → `npm run build` で `frontend/dist` を作る)
- `scripts/site/export-data.mjs` / `scripts/site/import-data.mjs` — 停止中の Postgres の論理ダンプと、退避付きの復元。手順・形式・拠点ごとの設定は [site-data-transfer.md](site-data-transfer.md)。

### ポートと frontend の配信

- backend (`cernere`) の catalog port は **8086** (正本拠点の AWS で 8080 を synergos-relay が使うため。2026-10-11)。
  `LISTEN_PORT`・health・`provides` (`CERNERE_URL` 等) は catalog の port に追随します。
  server の `LISTEN_PORT` 既定値 (8080) と docker compose は変えていません。catalog 経由の起動は env で 8086 が入ります。
- frontend (`cernere-frontend`) は catalog の command を **`vite preview`** にしています。拠点ではメモリの小さい
  Vite dev server を常駐させず、setup がビルドした `frontend/dist` を配ります。`/api`・`/auth`・`/ws/project`・
  `/.well-known` は `vite.config.ts` の preview proxy で `VITE_BACKEND_URL` (8086) へ渡します。
  ソースを変えたら setup (または `npm run build --prefix frontend`) で再ビルドしてから再起動します (hot reload しません)。
- dev で使う場合は従来どおり `npm run dev --prefix frontend`、本社のテスト用は `cernere-frontend-test` (dev server) です。

起動前に、その拠点の Vault 紐付けで上の必須値を揃えます。`DATABASE_URL` / `REDIS_URL` は拠点内の Postgres / Redis を指します。

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

workload 認証局の `POST /api/workload/*` は別ポートの HTTPS 待受だけで受け付け、上記の平文待受では 403 を返す ([workload-deploy.md](workload-deploy.md))。

> `/oauth/*` や `/ws/service` といったパスは**存在しない**。OAuth は `/auth/github/*` `/auth/google/*` のコールバックのみ、サービス WS は `/ws/project`。連携実装で経路を誤らないこと。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `[env-bootstrap] missing Vault-injected env: ...` | Vault の値と `cernere` の紐付けを確認する。値はログへ貼らない。 |
| `JWT_SECRET must be set` | Excubitor Vault から固定の署名鍵を注入する。 |
| port を変えても反映されない | catalog と `LISTEN_PORT` を確認する。 |
| `Workload TLS listener requires ...` | workload TLS の 3 設定を全て揃えるか全て外す ([workload-deploy.md](workload-deploy.md))。 |
| 起動時に `[migrate] Failed to apply` | 直前 build に戻し、`npm --prefix server run migrate:dry-run` で再現する ([workload-deploy.md](workload-deploy.md))。 |
