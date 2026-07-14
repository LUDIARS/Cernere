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
- **鍵未設定時の挙動** — production では OIDC を無効化 (503)、 dev は ephemeral 鍵生成。

---

## 7. 関連ファイル

| 層 | ファイル |
|----|----------|
| 署名鍵 / JWKS | `server/src/auth/oidc-keys.ts` |
| scope/claims/PKCE/discovery | `server/src/oidc/scopes.ts` |
| Redis 短命レコード | `server/src/oidc/store.ts` |
| クライアントストア | `server/src/oidc/clients.ts` |
| コアフロー | `server/src/oidc/provider.ts` |
| HTTP ハンドラ | `server/src/http/oidc-handler.ts` |
| ルート配線 | `server/src/app.ts` |
| クライアント管理 (WS) | `server/src/commands.ts` (`oidc_client` module) |
| consent UI | `frontend/src/pages/oidc/OidcConsentPage.tsx` |
| テスト | `server/tests/oidc/scopes.test.ts`, `server/tests/auth/oidc-keys.test.ts` |
