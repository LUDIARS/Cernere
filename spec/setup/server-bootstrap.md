# Cernere サーバを起動するための設定

Cernere バックエンド (uWebSockets.js) を起動するのに最低限必要な設定軸を扱う。秘密管理 (Infisical) は [infisical-secrets.md](infisical-secrets.md)、署名鍵は [paseto-keys.md](paseto-keys.md) を参照。

## 目的

DB (PostgreSQL 17) と Redis (7) に接続し、HTTP/WS を listen するところまで。エントリは `server/src/bootstrap.ts` → `ensureEnv()` → `createApp()` (`server/src/app.ts`)。

## 設定キー

`server/src/config.ts` が実際に読むキー。フォールバックは dev 用既定値で、`required.production` (`env-cli.config.ts`) のものは production で欠けると起動が止まる。

| キー | 既定 (dev) | production 必須 | 用途 |
|---|---|---|---|
| `DATABASE_URL` | `postgres://cernere:cernere@localhost:5432/cernere` | ✅ | PostgreSQL 接続文字列 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | ✅ | Redis 接続文字列 (セッション / レートリミット等) |
| `JWT_SECRET` | プロセス起動毎にランダム生成 (warn) | ✅ | HS256 トークン (user / project / tool / MFA) の署名鍵 |
| `LISTEN_PORT` | `8080` | — | HTTP/WS の listen ポート |
| `FRONTEND_URL` | `http://localhost:5173` | — | CORS 許可 origin + `isHttps` 判定 + WebAuthn 既定 RP |
| `CERNERE_ENV` / `APP_ENV` / `NODE_ENV` | (未指定=development) | — | `production` / `prod` で本番モード |

> **注意 — `LISTEN_PORT` であって `LISTEN_ADDR` ではない**: `.env.example` / `env-cli.config.ts` には `LISTEN_ADDR=0.0.0.0:8080` があるが、`config.ts` が実際に読むのは `LISTEN_PORT` (`parseInt(env("LISTEN_PORT","8080"))`)。`docker-compose.yaml` も `LISTEN_PORT: "8080"` を渡している。port を変えたいときは `LISTEN_PORT` を設定する。

OAuth / Mail / MFA / WebAuthn 等の任意キーは [config-reference.md](config-reference.md) を参照 (未設定でも起動はする)。

## 起動手順

`npm run env:*` 系はすべて Infisical から env を取得して `.env` を一時生成 → `docker compose up` → 終了後 `.env` を削除する (`package.json` の scripts)。

| コマンド | モード | DB/Redis | compose ファイル / profile |
|---|---|---|---|
| `npm run env:up` | dev | 外部 (Infra) | `docker-compose.yaml` / `dev` |
| `npm run env:up:prod` | prod | 外部 (Infra) | `docker-compose.yaml` / `prod` |
| `npm run env:up:standalone` | standalone | 内蔵 | `+ docker-compose.standalone.yaml` / `prod` |
| `npm run env:up:standalone:dev` | standalone-dev | 内蔵 | `+ docker-compose.standalone.yaml` / `dev` |
| `npm run env:up:fg` | dev (前景) | 外部 | `--abort-on-container-exit` |

dev モードは `infra_default` ネットワーク (external) に属して `postgres:5432` / `redis:6379` を service 名で直結する。`docker-compose.yaml` のコメント参照。

### Docker なし直接起動

```bash
npm run env:gen           # Infisical → .env を生成 (削除しない)
cd server && npm run dev   # tsx watch src/bootstrap.ts
cd frontend && npm run dev # 別ターミナル (Vite)
```

Infisical を使わない場合は `.env` を手書きするか、host shell で env を export してから `npx tsx server/src/bootstrap.ts` を起動する。`ensureEnv()` は必須キーが揃っていれば Infisical fetch をスキップする ([infisical-secrets.md](infisical-secrets.md))。

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

| 症状 | 原因 / 対処 |
|---|---|
| 起動時 `JWT_SECRET must be set in production` | production モードで `JWT_SECRET` 未設定。Infisical に登録するか env で渡す。 |
| dev で再起動するたびに既存トークンが 401 | `JWT_SECRET` 未設定時はプロセス毎にランダム鍵を生成する仕様 (`config.ts` の M-2 対策)。固定したいなら `JWT_SECRET` を設定する。 |
| `[env-bootstrap] still missing after Infisical fetch` | Infisical に必須キー (`DATABASE_URL` 等) が未登録。`npm run env:initialize` → `env:set` で補う ([infisical-secrets.md](infisical-secrets.md))。 |
| dev container が glibc エラーで落ちる | uWebSockets.js v20.60+ は glibc 2.38+ 必須。base image は `node:24-trixie-slim` (compose に固定済み)。 |
| port を変えたのに 8080 のまま | `LISTEN_ADDR` ではなく `LISTEN_PORT` を設定する (上記注意)。 |
