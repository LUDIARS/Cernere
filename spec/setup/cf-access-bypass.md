# Cloudflare Access バイパス認証のセットアップ

企業用 Hub (Corpus 派生) を Cloudflare Access の背後に置き、そこで済ませた認証を
Cernere へ引き渡す構成の手順。機能仕様は
[`spec/feature/edge-assertion-login.md`](../feature/edge-assertion-login.md)。

---

## 0. 構成の前提

```
社員ブラウザ → Cloudflare Access → cloudflared tunnel → Hub (Corpus)
                                                          └── project WS ──→ Cernere
```

**Hub のインバウンドポートを開けないこと。** Cloudflare 経由以外で到達できる状態だと、
`Cf-Access-Jwt-Assertion` ヘッダを直接付けるだけで任意ユーザに成りすませる。
トンネル以外の到達経路が無いことは、構築後に**社外ネットワークから直接 IP/ポートを
叩いて拒否されること**で確認する (§5)。

---

## 1. Cloudflare 側

### 1.1 Tunnel

1. `cloudflared tunnel create <name>` でトンネルを作成。
2. `config.yml` で `hub.example.com` → `http://127.0.0.1:<CORPUS_PORT>` を割り当てる。
3. Hub ホストのファイアウォールで当該ポートへの外部アクセスを閉じる (loopback のみ)。

### 1.2 Access Application

Zero Trust → Access → Applications → Add an application → Self-hosted。

| 項目 | 値 |
|---|---|
| Application domain | `hub.example.com` |
| Session Duration | 業務に合わせる (例 24h)。 短いほど offboarding が早く効く |
| Identity providers | 企業 IdP (Entra ID / Google Workspace / Okta / SAML) または One-time PIN |
| Policy | Allow: emails ending in `@example.co.jp` (+ 必要ならグループ条件) |

作成後、**Application Audience (AUD) Tag** を控える。Cernere 側の binding 登録に使う。

> CF Access の login method に **Cernere OIDC** を選ぶこともできる
> ([`oidc-provider.md`](../feature/oidc-provider.md) の設定)。本経路は上流 IdP を
> 問わないので、その場合も Cernere 側の設定は同じ。

### 1.3 team domain

`https://<team>.cloudflareaccess.com` が team domain。JWKS は
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` に公開される。

---

## 2. Cernere 側 (binding 登録)

admin セッションで WS module `edge_idp` の `register` を呼ぶ。

```jsonc
{ "module": "edge_idp", "action": "register",
  "payload": {
    "projectKey": "<hub の project key>",
    "teamDomain": "<team>.cloudflareaccess.com",
    "audTags": ["<Application AUD Tag>"],
    "allowedEmailDomains": ["example.co.jp"],
    "provisioning": "auto",            // auto | link_only | invite_only
    "defaultRole": "general"
  } }
```

| 値 | 選び方 |
|---|---|
| `provisioning: auto` | 社員全員に Hub を開放する通常運用。 CF ポリシー + `allowedEmailDomains` の二重で入場制御する |
| `provisioning: link_only` | Cernere に既にアカウントがある人だけ通す (LUDIARS 内部利用・段階移行時) |
| `provisioning: invite_only` | 事前招待した人だけ通す |

`allowedEmailDomains` は空にできない。CF 側ポリシーの設定ミスに対する二重化なので、
「CF で絞っているから不要」という理由で空にしない。

---

## 3. Hub (Corpus) 側

| env | 値 |
|---|---|
| `CORPUS_AUTH_MODE` | `edge` (明示必須。 未設定は起動拒否) |
| `CORPUS_EDGE_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
| `CORPUS_EDGE_AUD` | Application AUD Tag |
| `CORPUS_PUBLIC_URL` | `https://hub.example.com` |
| `CERNERE_BASE_URL` | Cernere の到達先 |
| `CERNERE_PROJECT_CLIENT_ID` / `_SECRET` | Excubitor が起動時に注入 (固定保存しない) |

Hub 側でもヘッダを検証する (Cernere 往復前に落とせるものは落とす)。詳細は
LUDIARS/Corpus `DESIGN.md` §16。

### 開発時

`CORPUS_EDGE_DEV_IDENTITY=<email>` で CF を経由せずに固定 identity を使える。
これは `NODE_ENV !== production` かつ listen が loopback のときのみ有効で、
本番設定で渡された場合は**起動時に拒否**する。

---

## 4. ログアウト

Hub の `/auth/logout` は Cookie 破棄後に `/cdn-cgi/access/logout` へ 302 する。
CF セッションを残したままだと即座に再ログインされ、「ログアウトできない」挙動になる。

---

## 5. 動作確認

```bash
# 1. トンネル以外から到達できないこと (社外ネットワークから)
curl -sS -o /dev/null -w '%{http_code}\n' http://<hub-host>:<port>/api/health   # 接続不可であること

# 2. CF 経由でヘッダが届いていること (Hub のログで確認)
#    Cf-Access-Jwt-Assertion が付いていない場合は 401 になる

# 3. JWKS が引けること
curl -s https://<team>.cloudflareaccess.com/cdn-cgi/access/certs | jq '.keys | length'
```

ブラウザで `https://hub.example.com/` → 企業 IdP のログイン → **Hub のログイン画面を
経ずに** そのままダッシュボードが表示されれば成功。Cernere 側では該当ユーザの
`edge_identities` 行と `project_data_<key>` の行が生成される。

---

## 6. 運用上の注意

- **CF Access の policy を緩めると Cernere のアカウントが自動生成される** (`auto` の場合)。
  policy 変更は `allowedEmailDomains` とセットで見直す。
- 社員の退職時は IdP 側で無効化すれば CF を通れなくなる。Cernere 側のユーザ行は残るので、
  棚卸しは `edge_identities.last_seen_at` を見る。
- CF の署名鍵ローテーションは JWKS 側で自動追従する (未知 `kid` で 1 回だけ再取得)。
- Hub のドメインを変えると AUD Tag も変わる。binding の `audTags` を更新すること。
