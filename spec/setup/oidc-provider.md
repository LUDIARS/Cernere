# OIDC Provider のセットアップ (鍵生成 + Cloudflare Access 連携)

Cernere を OpenID Connect IdP として外部サービスのログインに使うための設定。
機能仕様は [`spec/feature/oidc-provider.md`](../feature/oidc-provider.md)。

実装: `server/src/auth/oidc-keys.ts` (署名鍵) / `server/src/oidc/` (フロー) /
`server/src/http/oidc-handler.ts` (エンドポイント)。

---

## 設定キー

| キー | 必須 | 形式 | 用途 |
|------|------|------|------|
| `CERNERE_PUBLIC_URL` | 本番ほぼ必須 | URL (末尾 `/` 無視) | 外部から Cernere に到達する URL。 OIDC エンドポイントと issuer の基準 |
| `CERNERE_OIDC_ISSUER` | 任意 (既定 = `CERNERE_PUBLIC_URL`) | URL | discovery の `issuer` と id_token の `iss` |
| `CERNERE_OIDC_PRIVATE_KEY` | 本番必須 | RSA PKCS8 PEM (raw or base64) | id_token 署名鍵 |
| `CERNERE_OIDC_KID` | 任意 (既定 `oidc-1`) | 文字列 | JWKS の key id |

> `CERNERE_OIDC_PRIVATE_KEY` が **未設定の場合**:
> - development: 起動毎に ephemeral RSA 鍵を生成 (再起動で失効、 検証用途のみ)。
> - production: **OIDC を無効化** (各エンドポイントが 503 を返す)。 既存デプロイを落とさないための挙動。

リバースプロキシ / Cloudflare Tunnel 配下では `LISTEN_PORT` ではなく
**公開ホスト名** を `CERNERE_PUBLIC_URL` に設定すること
(例: `https://auth.example.com`)。

---

## 1. RSA 署名鍵を生成

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc.pem
# env / Infisical に貼る (1 行 base64)
echo "CERNERE_OIDC_PRIVATE_KEY=$(base64 -w0 oidc.pem)"
```

raw PEM をそのまま env に入れても良い (`-----BEGIN` を含めば PEM、 含まなければ
base64 とみなしてデコードする)。 Infisical / OS キーチェーンでの保管を推奨。

`oidc.pem` 自体はコミット・配布しない (秘密鍵)。

---

## 2. RP (Cloudflare Access 等) を登録

### CLI

```bash
cd server
tsx scripts/register-oidc-client.ts \
  --name "Cloudflare Access" \
  --redirect https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
```

出力される `client_id` / `client_secret` を控える (**secret は再取得不可**)。

### WS (admin)

`oidc_client` module の `register` action (WS セッションは admin ユーザー)。
`list` / `rotate_secret` / `update_redirect_uris` / `enable` / `disable` も同 module。

---

## 3. Cloudflare Access 側の設定

Zero Trust → Settings → Authentication → Login methods → Add new → **OpenID Connect**。

| 項目 | 値 |
|------|-----|
| App ID / Client ID | 登録で得た `client_id` |
| Client secret | 登録で得た `client_secret` |
| Auth URL | `<CERNERE_PUBLIC_URL>/oidc/authorize` |
| Token URL | `<CERNERE_PUBLIC_URL>/oidc/token` |
| Certificate URL (JWKS) | `<CERNERE_PUBLIC_URL>/.well-known/jwks.json` |
| Scopes | `openid email profile` |

Cloudflare の callback URL (`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`)
を登録時の `--redirect` に **完全一致** で含めること。

> discovery (`/.well-known/openid-configuration`) に対応した RP なら、
> issuer URL を渡すだけで各エンドポイントを自動取得できる。

---

## 4. 動作確認

```bash
# discovery
curl -s <CERNERE_PUBLIC_URL>/.well-known/openid-configuration | jq .
# JWKS (RS256 公開鍵が 1 つ返る)
curl -s <CERNERE_PUBLIC_URL>/.well-known/jwks.json | jq .
```

ブラウザで `/oidc/authorize?...` にアクセス → Cernere ログイン → consent →
`redirect_uri` に `?code=...&state=...` で戻れば成功。

---

## 5. 鍵ローテーション

現状 JWKS は単一鍵 (`CERNERE_OIDC_KID`)。 ローテーションは:

1. 新しい RSA 鍵を生成し `CERNERE_OIDC_PRIVATE_KEY` / `CERNERE_OIDC_KID` を差し替えて再起動。
2. 既存 id_token は最大 1 時間 (`ID_TOKEN_TTL_SEC`) で失効するため、 その経過後は旧鍵不要。

複数鍵を JWKS に並べる移行ウィンドウ対応は将来拡張 (PASETO 鍵の `_PREVIOUS_` 相当)。
