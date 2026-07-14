# Cernere 設定キー リファレンス

Cernere が実際に読む環境変数の正本テーブル。各キーは下記いずれかで参照される (出典を「読む場所」列に明記):

- `server/src/config.ts` — アプリ設定の中心
- `server/src/auth/paseto.ts` — project-token 署名鍵
- `server/src/lib/env-bootstrap.ts` — 起動時 Infisical 注入
- `server/src/logging/*` — ログ出力先
- `server/src/ws/handler.ts` — `NODE_ENV` 分岐
- `docker-compose*.yaml` / `frontend` (Vite) — インフラ / フロント

> 既定値・宣言は `../../.env.example` と `../../env-cli.config.ts`。`env-cli.config.ts` の `infraKeys` に載るキーは Infisical 優先・無ければ既定値。`required.production` (`JWT_SECRET` / `DATABASE_URL` / `REDIS_URL`) は production で placeholder のままだと `.env` 生成を中止する。

## アプリケーション (config.ts)

| キー | 既定 | 読む場所 | 用途 |
|---|---|---|---|
| `DATABASE_URL` | `postgres://cernere:cernere@localhost:5432/cernere` | config.ts | PostgreSQL 接続文字列 (prod 必須) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | config.ts | Redis 接続文字列 (prod 必須) |
| `LISTEN_PORT` | `8080` | config.ts / compose | HTTP/WS listen ポート (※ `LISTEN_ADDR` は読まれない) |
| `FRONTEND_URL` | `http://localhost:5173` | config.ts | CORS origin + `isHttps` 判定 + WebAuthn 既定 RP/origin |
| `JWT_SECRET` | 起動毎ランダム生成 (dev、warn) | config.ts | HS256 署名鍵 (user/project/tool/MFA token) (prod 必須) |
| `CERNERE_PUBLIC_URL` | `http://localhost:<LISTEN_PORT>` | config.ts | 外部到達 URL。 OIDC エンドポイント/issuer の基準 (proxy 配下は公開ホストを指定) |
| `CERNERE_OIDC_ISSUER` | `CERNERE_PUBLIC_URL` | config.ts | OIDC discovery の `issuer` / id_token の `iss` |
| `CERNERE_ENV` / `APP_ENV` / `NODE_ENV` | `""` (=development) | config.ts / ws/handler.ts | `production`/`prod` で本番モード |

## 環境判定の補足

`CERNERE_ENV` → `APP_ENV` → `NODE_ENV` の順に評価。`production` / `prod` で本番、空 / `development` / `dev` で開発扱い。本番では一部スイッチ (下記 identity / paseto 等) のガードが厳しくなる。

## OAuth (config.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `GITHUB_CLIENT_ID` | `""` | GitHub OAuth |
| `GITHUB_CLIENT_SECRET` | `""` | 〃 |
| `GITHUB_REDIRECT_URI` | `http://localhost:8080/auth/github/callback` | 〃 コールバック |
| `GOOGLE_CLIENT_ID` | `""` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | `""` | 〃 |
| `GOOGLE_REDIRECT_URI` | `http://localhost:8080/auth/google/callback` | 〃 コールバック |

## PASETO project-token (paseto.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `CERNERE_PASETO_SECRET_KEY` | (未設定=user×project token 不可) | base64 Ed25519 seed (32B) or seed‖public (64B)。署名鍵。未設定だと `/api/auth/project-token` は `500` (HS256 へ暗黙降格しない) |
| `CERNERE_PASETO_PUBLIC_KEY` | (同上) | base64 raw 公開鍵 (32B)。検証・公開用 |
| `CERNERE_PASETO_KID` | `v1` | 現行鍵の kid |
| `CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS` | (なし) | `kid:base64,...` ローテーション中の旧公開鍵 (検証専用) |

詳細・罠は [paseto-keys.md](paseto-keys.md)。`_SECRET_KEY` と `_PUBLIC_KEY` 両方揃って有効化。

## OIDC Provider id_token 署名 (auth/oidc-keys.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `CERNERE_OIDC_PRIVATE_KEY` | (未設定: dev=ephemeral 生成 / prod=OIDC 無効) | RSA PKCS8 PEM (raw or base64)。 id_token (RS256) 署名鍵 |
| `CERNERE_OIDC_KID` | `oidc-1` | JWKS の key id |

PASETO (project-token、 Ed25519) とは別の鍵・別用途 (外部 RP に配る id_token 専用)。詳細は [oidc-provider.md](oidc-provider.md)。

## MFA / AWS (config.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `AWS_REGION` | `ap-northeast-1` | AWS リージョン |
| `AWS_SNS_ENABLED` | `false` | SMS MFA (SNS) 有効化 |
| `AWS_SES_ENABLED` | `false` | Email 送信に SES を使う (true で SMTP より優先) |
| `AWS_SES_FROM_EMAIL` | `noreply@example.com` | SES 送信元 |
| `APP_NAME` | `Cernere` | アプリ名 (WebAuthn RP 名既定にも使用) |

## Mail / SMTP (config.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `CERNERE_SMTP_HOST` | `localhost` | SMTP ホスト (dev は Infra の MailHog `localhost:1025`) |
| `CERNERE_SMTP_PORT` | `1025` | SMTP ポート |
| `CERNERE_SMTP_USER` | `""` | SMTP ユーザ |
| `CERNERE_SMTP_PASS` | `""` | SMTP パスワード |
| `CERNERE_MAIL_FROM` | `noreply@cernere.local` | 送信元 (SES 無効時) |

## WebAuthn / Passkey (config.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `WEBAUTHN_RP_NAME` | `APP_NAME` (=`Cernere`) | RP 表示名 |
| `WEBAUTHN_RP_ID` | `FRONTEND_URL` のホスト名 | RP ID (eTLD+1) |
| `WEBAUTHN_ORIGINS` | `FRONTEND_URL` | 許可 origin (カンマ区切りで複数可) |

## Identity (device) verification (config.ts)

| キー | 既定 | 用途 |
|---|---|---|
| `CERNERE_IDENTITY_VERIFICATION_DISABLED` | `false` | true で本人確認を全スキップ (常に trusted)。**production では true 不可** (起動時例外)。dev / メール送信障害時の緊急退避用 ([../identity-verification.md](../identity-verification.md)) |

## ログ出力 (logging/*)

| キー | 既定 | 用途 |
|---|---|---|
| `LOG_DIR` | `<cwd>/logs` | 認証ログのファイル出力先 |
| `LOG_AUTH_FILE` | `true` | `false` で認証ログのファイル出力を無効化 |
| `CERNERE_DEV_LOG` | (未指定=isDevelopment に従う) | `true`/`1` で devLog 強制有効、`false`/`0` で無効 |

## Infisical bootstrap (env-bootstrap.ts / .env.secrets)

| キー | 既定 | 用途 |
|---|---|---|
| `SECRETS_PROVIDER` | (なし) | `infisical` 指定 (.env 内の宣言用) |
| `INFISICAL_SITE_URL` | (なし) | Infisical ベース URL |
| `INFISICAL_PROJECT_ID` | (なし) | workspace ID |
| `INFISICAL_ENVIRONMENT` | `dev` | 取得環境 |
| `INFISICAL_CLIENT_ID` | (なし) | universal-auth client id |
| `INFISICAL_CLIENT_SECRET` | (なし) | universal-auth client secret |

`ensureEnv()` は必須キー (`DATABASE_URL`/`REDIS_URL`/`JWT_SECRET`/`GITHUB_*`/`GOOGLE_*`/`FRONTEND_URL`) が env に欠けている場合のみ上記で Infisical fetch する。詳細は [infisical-secrets.md](infisical-secrets.md)。

## インフラ / Docker / フロント (compose / env-cli.config.ts / Vite)

| キー | 既定 | 用途 |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `cernere` | standalone の内蔵 PostgreSQL |
| `POSTGRES_PORT` | `5432` | 〃 |
| `REDIS_PORT` | `6379` | standalone の内蔵 Redis |
| `FRONTEND_PORT` | `5173` | フロント公開ポート (compose) |
| `VITE_BACKEND_URL` | `http://cernere-backend-dev:8080` | dev フロントの API/WS 先 (compose) |
| `VITE_ALLOWED_HOSTS` | `""` | Vite 許可ホスト (例: 公開ドメイン) |
| `CI` | (compose で `true`) | dev container フラグ |

> `LISTEN_ADDR` は `.env.example` / `env-cli.config.ts` の `infraKeys` に存在するが、**`config.ts` は読まない** (port は `LISTEN_PORT`)。歴史的な残骸キーであり、port 変更時は `LISTEN_PORT` を設定すること。
