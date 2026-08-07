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
| `CERNERE_OIDC_MODE` | 任意 (既定 `auto`) | `auto` / `off` | `off` で OIDC を明示的に使わない。 鍵の生成も DB 参照もしない |
| `CERNERE_OIDC_PRIVATE_KEY` | 任意 | RSA PKCS8 PEM (raw or base64) | id_token 署名鍵 (現行)。 未設定なら DB の鍵を使う |
| `CERNERE_OIDC_KID` | 任意 (既定 `oidc-1`) | 文字列 | JWKS の現行 key id |
| `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` | 任意 (ローテーション時のみ) | `kid:base64(PEM)` をカンマ区切り | 検証専用の旧 public key。 JWKS に並べて移行ウィンドウ中の id_token 検証を維持する |

鍵の解決順は **env → DB → 生成して DB に保存** (`oidc_signing_keys`、 migration 039)。
`CERNERE_OIDC_PRIVATE_KEY` を置かなくても kid は再起動をまたいで安定するので、
外部 secret store への登録は必須ではない。 env を置いた場合は従来どおりそちらが優先される
(多重インスタンスで鍵を共有したい場合はこちら)。

DB に保存する private key は `CERNERE_SECRET_KEY` で AES-256-GCM 暗号化する
(RULE.md §7.2、 平文フォールバック無し)。 **env に鍵を置かず DB 経路を使うなら
`CERNERE_SECRET_KEY` の設定が前提**で、 未設定だと鍵を保存/復号できず OIDC は
警告のうえ無効化される (起動は止まらない)。

> **OIDC を使わない構成が正常系にある** (neco 裁定 2026-08-04)。 EducationLab のように Cernere 認証だけで
> 完結するデプロイは OIDC Provider を必要としない。 そのため:
> - `CERNERE_OIDC_MODE=off` — 明示的に無効化。 鍵を生成せず DB も触らない。 **起動は止まらない**
> - DB の鍵ストアに到達できない場合も、 警告を出して無効化するだけで起動は続行する
> - 無効時は各 OIDC エンドポイントが `503 oidc_disabled` を返す (クラッシュしない)
>
> 例外は「env に鍵を明示したのに読めない」ケースだけで、 これは設定ミスなので起動時に落とす。

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

JWKS には現行署名鍵に加えて「検証専用の旧鍵」を並べられる
(`CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS`)。 これにより旧鍵で署名済みの未失効
id_token を RP が検証できる移行ウィンドウを確保したまま、 無停止で署名鍵を
切り替えられる。 PASETO project-token の `CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS`
と同方式。

### ゼロダウンタイム手順

1. **新 RSA 鍵を生成** (新しい kid を決める。 例 旧 `oidc-1` → 新 `oidc-2`)。

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc-2.pem
   ```

2. **旧鍵の public を退避**。 現行 `CERNERE_OIDC_PRIVATE_KEY` から public を取り出し、
   旧 kid を付けて `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` に追記する。

   ```bash
   # 現行の秘密鍵 (oidc.pem) から SPKI public を取り出して 1 行 base64 に
   openssl pkey -in oidc.pem -pubout -out oidc-1.pub.pem
   echo "oidc-1:$(base64 -w0 oidc-1.pub.pem)"   # ← _PREVIOUS_PUBLIC_KEYS に追記
   ```

   複数世代を残す場合はカンマ区切りで並べる (`oidc-1:...,oidc-0:...`)。

3. **現行鍵を新鍵に差し替えて再起動**。

   ```
   CERNERE_OIDC_PRIVATE_KEY=$(base64 -w0 oidc-2.pem)
   CERNERE_OIDC_KID=oidc-2
   CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS=oidc-1:<base64 of oidc-1.pub.pem>
   ```

   起動後、 `GET /.well-known/jwks.json` に `oidc-2` (current) と `oidc-1` の
   2 鍵が並ぶ。 新規 id_token は `oidc-2` で署名され、 RP は header の `kid` で
   公開鍵を選んで検証する。

4. **旧鍵の撤去**。 旧 id_token の TTL (`ID_TOKEN_TTL_SEC` = 1h) + RP 側の
   JWKS キャッシュ (discovery の `max-age=300`) を十分に過ぎたら、
   `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` から `oidc-1` を外して再起動。

> 旧 public は **検証専用**なので漏洩しても署名能力には繋がらない。 退避した
> 秘密鍵 (`oidc.pem`) は撤去完了後に破棄する。

### 運用上の確認

- admin は管理画面 (Web の **OIDC** タブ → 「署名鍵 (JWKS)」) で現行 kid と
  公開中の旧 kid を確認できる (WS `oidc_keys` module の `status` action)。
- `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` に現行 kid と同じ kid を入れると起動時に
  `duplicate kid` で落ちる (設定ミス検知)。
