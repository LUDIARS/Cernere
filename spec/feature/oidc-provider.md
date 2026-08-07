# OIDC Provider (Cernere を IdP とする OpenID Connect)

Cernere を **OpenID Connect Provider (IdP)** として動作させ、 外部 Relying Party
(Cloudflare Access など) が Cernere のアカウントでログインできるようにする。

ログイン自体は Cernere が担う (Google/GitHub OAuth・パスワード・パスキー・MFA は
すべて既存フローを再利用)。 RP には認可コードフローで `id_token` を渡す。

> セットアップ手順 (鍵生成・Cloudflare Access 登録) は
> [`spec/setup/oidc-provider.md`](../setup/oidc-provider.md) を参照。

---

## 1. 採用フロー / 署名

| 項目 | 採用 | 理由 |
|------|------|------|
| フロー | Authorization Code + PKCE (S256) | ブラウザ経由で id_token を漏らさない標準形。 PKCE は public client / 横取り対策 |
| id_token 署名 | **RS256** (RSA-2048) | Cloudflare Access generic OIDC をはじめ RP 互換性が最も高い。 EdDSA は RP 対応が不確実 |
| access_token | 不透明乱数 (Redis 保管) | userinfo 専用。 失効可能・JWT パース不要 |
| consent | フロント (`/oidc/consent`) が仲介 | サーバーはブラウザセッション cookie を持たないため、 SPA が user token で承認する |

`project-token` 用の Ed25519/PASETO 鍵 ([`auth/paseto.ts`](../../server/src/auth/paseto.ts)) とは
**別の鍵・別の用途**。 OIDC は「外部 RP に配る id_token 専用」。

### 1.1 署名鍵の解決とローテーション

署名鍵は起動時に一度だけ解決する (`initOidcKeys()`、 migration 実行後・listen 前)。
解決順は上から先に一致したものを採用する。

| # | 供給元 | 条件 | kid |
|---|--------|------|-----|
| 1 | (無効化) | `CERNERE_OIDC_MODE=off` | — |
| 2 | env | `CERNERE_OIDC_PRIVATE_KEY` (PKCS8 PEM, raw or base64) | `CERNERE_OIDC_KID` (既定 `oidc-1`) |
| 3 | DB | `oidc_signing_keys` の `is_current` 行 (migration `039_oidc_signing_keys.sql`) | 保存済みの `kid` |
| 4 | DB (生成) | 3 が無い場合、 RSA-2048 を生成して `is_current` で INSERT | `oidc-<8 hex>` |

- **DB 永続化により kid が再起動をまたいで安定する**。 外部 secret store への登録は必須ではない。
  多重インスタンスで鍵を共有したい場合のみ env (#2) を使う。
- `private_key_pem` は **保存時暗号化** (`encryptSecret()` / AES-256-GCM, `CERNERE_SECRET_KEY`)。
  RULE.md §7.2「シークレットは平文でファイル/DB に保存しない」に従う。
- 同時起動時の競合は `idx_oidc_signing_keys_current` (partial unique index) が防ぐ。
  INSERT が衝突した側は現行行を読み直して採用する。

**JWKS に載る鍵** = 現行鍵 + 検証専用の旧 public key。 旧鍵の供給元は 2 つ:

1. `oidc_signing_keys.retired_at` が `ID_TOKEN_TTL_SEC` (3600s) 以内の行
2. env `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` (`kid:base64(PEM)` をカンマ区切り)

移行ウィンドウ (旧 id_token の TTL + RP 側 JWKS キャッシュ) を過ぎたら旧鍵を外す。

- DB 由来の鍵 (現行・retired とも) の **JWKS public key は private key から導出する**。
  `public_key_pem` 列は暗号化も改竄検知もされないため、 これを信用すると「署名に使っていない鍵」
  を検証鍵として公開してしまう。 同列は運用時の参照用に保持するだけで、 公開経路には使わない。
- retired 行が 1 本壊れていても (復号不能・非 RSA 等) その kid を警告のうえ読み飛ばすだけで、
  現行鍵での署名/検証と起動は継続する。
- `_PREVIOUS_PUBLIC_KEYS` に既出の kid (現行鍵や DB の retired 行) を並べても起動は止まらず、
  先に採用済みの鍵を残す。 env 内での kid 重複だけは設定ミスとして throw する。

> **未実装**: 現行 DB 鍵を `is_current=false` + `retired_at` へ落とす経路がまだ無く、
> DB 鍵のローテーションは env (#2 と `_PREVIOUS_PUBLIC_KEYS`) 経由でしか行えない。
> `retired_at` を書く admin 操作は別タスク。

---

## 2. エンドポイント

### 外部 RP 向け (public, CORS `*`)

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/.well-known/openid-configuration` | discovery ドキュメント |
| GET | `/.well-known/jwks.json` | id_token 検証用 RSA 公開鍵 (JWK) |
| GET | `/oidc/authorize` | 認可エンドポイント。 検証後 consent 画面へ 302 |
| POST | `/oidc/token` | code → `id_token` + `access_token` 交換 |
| GET | `/oidc/userinfo` | `Bearer access_token` → claims |

### フロント (consent 仲介, CORS = `FRONTEND_URL` + credentials)

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/api/auth/oidc/request?request_id=` | consent 表示用 (client 名・scope・redirect 先) |
| POST | `/api/auth/oidc/approve` | `{ request_id }` + `Bearer` user token → code 発行 |
| POST | `/api/auth/oidc/deny` | `{ request_id }` → `error=access_denied` で RP へ戻す |

`issuer` と各エンドポイントの URL は `CERNERE_OIDC_ISSUER`
(既定は `CERNERE_PUBLIC_URL`) を基準に組み立てる。

---

## 3. フロー詳細

```
RP (Cloudflare)                Cernere server              Cernere frontend           User
   |  GET /oidc/authorize          |                            |                       |
   |------------------------------>| validate client_id /       |                       |
   |                               | redirect_uri / scope        |                       |
   |                               | store oidc:req:{id} (Redis) |                       |
   |  302 -> /oidc/consent?req_id  |                            |                       |
   |<------------------------------|                            |                       |
   |   (browser follows redirect)  |                            |                       |
   |------------------------------------------------------------>| (未ログインなら LoginPage) |
   |                               |   GET /api/auth/oidc/request|<--- 表示情報 ----------|
   |                               |<---------------------------|                       |
   |                               |                            |---- 許可ボタン ------->|
   |                               |  POST /approve (Bearer)    |                       |
   |                               |<---------------------------|                       |
   |                               | mint oidc:code:{code}      |                       |
   |                               | -> { redirectTo }          |                       |
   |  302 redirect_uri?code&state  |                            |                       |
   |<--------------------------------------- window.location ---|                       |
   |  POST /oidc/token (code)      |                            |                       |
   |------------------------------>| verify client_secret /     |                       |
   |                               | redirect_uri / PKCE        |                       |
   |                               | consume code (GETDEL)      |                       |
   |  { id_token, access_token }   | sign id_token (RS256)      |                       |
   |<------------------------------|                            |                       |
   |  GET /oidc/userinfo (Bearer)  |                            |                       |
   |------------------------------>| lookup oidc:at:{token}     |                       |
   |  { sub, email, ... }          |                            |                       |
   |<------------------------------|                            |                       |
```

### Redis レコード

| キー | 内容 | TTL |
|------|------|-----|
| `oidc:req:{id}` | authorize リクエスト (consent 待ち) | 600s |
| `oidc:code:{code}` | authorization code (1 回限り, `GETDEL` で原子的に消費) | 120s |
| `oidc:at:{token}` | 発行済 access_token (userinfo 用) | 3600s |

---

## 4. claims

`sub` は常に発行。 scope に応じて付加する。

| scope | claims |
|-------|--------|
| `openid` | `sub` |
| `email` | `email`, `email_verified` (google/github 連携済みなら true) |
| `profile` | `name`, `preferred_username`, `picture` |

id_token には上記に加え `iss` / `aud`(=client_id) / `iat` / `exp` / `auth_time` / `nonce` を含む。

---

## 5. クライアント (RP) 管理

`oidc_clients` テーブル (migration `023_oidc_clients.sql`) で管理。

- `client_secret` は bcrypt ハッシュ保存。 平文は登録/ローテーション時に **1 度だけ** 返す。
- `redirect_uris` は **完全一致** のみ許可 (open redirect 防止)。 https 必須 (localhost 除く)。
- 登録手段:
  - WS module `oidc_client` (admin 専用): `register` / `list` / `rotate_secret` / `update_redirect_uris` / `enable` / `disable`
  - CLI: [`server/scripts/register-oidc-client.ts`](../../server/scripts/register-oidc-client.ts)

---

## 6. セキュリティ上の判断

- **plain PKCE 非対応** — S256 のみ。 `code_challenge_method=plain` は拒否。
- **code は one-time** — `GETDEL` で取得即削除。 二重交換は `invalid_grant`。
- **redirect_uri 完全一致** — authorize 時・token 時の双方で検証。
- **client_id / redirect_uri 不正時は redirect しない** — open redirect を避け、 エラーページを返す (RFC 6749 §4.1.2.1)。
- **署名鍵は平文保存しない** — DB 永続化する private key は `encryptSecret()` 経由 (§1.1)。
  `CERNERE_SECRET_KEY` 未設定なら平文フォールバックせず fail-closed (= OIDC 無効化)。
- **鍵を用意できない時は起動を止めず無効化** — `CERNERE_OIDC_MODE=off` の明示指定、
  および鍵ストア到達不能はいずれも警告のうえ OIDC 無効化 (各エンドポイントが 503)。
  OIDC を使わないデプロイ (EducationLab 等) を起動不能にしないため。
  例外は「env に鍵を明示したのに読めない」ケースで、 これは設定ミスなので起動時に落とす。

---

## 7. 関連ファイル

| 層 | ファイル |
|----|----------|
| 署名鍵 / JWKS | `server/src/auth/oidc-keys.ts` |
| 署名鍵ストア (DB) | `server/src/auth/oidc-key-repository.ts` |
| scope/claims/PKCE/discovery | `server/src/oidc/scopes.ts` |
| Redis 短命レコード | `server/src/oidc/store.ts` |
| クライアントストア | `server/src/oidc/clients.ts` |
| コアフロー | `server/src/oidc/provider.ts` |
| HTTP ハンドラ | `server/src/http/oidc-handler.ts` |
| ルート配線 | `server/src/app.ts` |
| クライアント管理 (WS) | `server/src/commands.ts` (`oidc_client` module) |
| consent UI | `frontend/src/pages/oidc/OidcConsentPage.tsx` |
| テスト | `server/tests/oidc/scopes.test.ts`, `server/tests/auth/oidc-keys.test.ts`, `server/tests/auth/oidc-key-persistence.test.ts` |
