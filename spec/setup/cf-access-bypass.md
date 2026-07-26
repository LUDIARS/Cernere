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

### 1.3 custom OIDC claims (任意)

**アカウントの正本キーは email なので、この設定は無くても動く。**
([`../feature/edge-assertion-login.md`](../feature/edge-assertion-login.md) §5.1)

設定すると **社員のメールアドレス変更 (姓変更・ドメイン統合) に追従できる**ように
なる。 未設定だとアドレス変更は新規アカウント扱いになる。

Zero Trust → Settings → Authentication → Login methods → 当該 IdP →
**Optional configurations → Custom OIDC claims**:

| IdP | 追加する claim | 用途 |
|---|---|---|
| Google Workspace | `sub` | email 変更への追従 (Google 上で不変) |
| Microsoft Entra ID | `oid` | 同上 |
| Okta / 汎用 OIDC | `sub` | 同上 |

追加した claim は JWT の `custom` に入る。 **Cookie サイズ制限のため約 1KB で
トリムされる** (best-effort) ので、 グループ一覧のような大きい属性は custom claim に
載せず get-identity で取る。

> **CF の `sub` は紐付けに使えない。** 「アカウント内で email ごとに一意」であり、
> ユーザの削除→再追加や別組織ログインで値が変わる。
>
> **表示名の claim (`name` 等) を足す必要は無い。** 表示名の初期値は email の
> `@` より前で作り、 ユーザが後から変更できる (§5.2.2)。

> **上流 IdP の client_id / access_token は origin に来ない。** JWT の `aud` は
> Access アプリの AUD tag であり、 `common_name` は CF サービストークンの Client ID。
> Google API を叩きたい場合は CF Access とは別に OAuth 連携が要る
> (Cernere の Google 連携 = [`../interface/oauth-token-storage.md`](../interface/oauth-token-storage.md))。

### 1.4 グループ取得 (Google Workspace) — グループを使う場合だけ

`user_uuid` / `name` / `groups` は **get-identity から既定で取得する**
([`../feature/edge-assertion-login.md`](../feature/edge-assertion-login.md) §5.3)。

| 取得したいもの | CF 側の追加設定 |
|---|---|
| `user_uuid` | **不要** |
| `name` | **不要** (Google Workspace ログインなら入る) |
| `amr` / `idp.type` / `geo` | **不要** |
| **`groups`** | **必要** — 下記のグループ連携設定 |

> **グループを使わないなら本節は丸ごとスキップしてよい。** その場合 CF / Google 側の
> 追加設定はゼロで、プレーンな Google IdP でも動く。 get-identity は既定で有効のまま
> にしておくこと (`name` は JWT の標準 claim ではないので、 追加設定ゼロで氏名を取れる
> のはこの経路だけ)。 CF への往復自体を避けたい場合は §2 の `fetchIdentity: false` と
> §1.3 の `name` custom claim を組み合わせる。

グループを取るには Google Workspace 側と CF 側の両方で設定が要る。

1. Google Cloud Platform で **Admin SDK API を有効化**する。
2. OAuth クライアント (認証情報) を作成する。
3. Google 管理コンソールで **「内部アプリを信頼」(Trust internal apps)** を有効にする。
4. Cloudflare One の Google Workspace IdP 設定に、作成した認証情報を登録する。
5. 保存後に **生成されるリンクを開き、Google Workspace 管理者として権限を承認する**
   (自分が管理者でない場合は管理者にリンクを共有する)。
6. Integrations → Identity providers → Google Workspace の **Test** を実行し、
   ユーザ identity と **グループが返ること**を確認する。

> **プレーンな Google IdP (非 Workspace) ではグループを取得できない。**
> グループが要るなら Google Workspace 統合を使うこと。

get-identity の呼び出し自体に追加設定は要らない (Access アプリがあれば動く)。
呼ぶのは **Cernere** で、Hub は `CF_Authorization` クッキーの値を転送するだけ
(署名の無い identity JSON を Hub から受け取らないため)。

### 1.5 team domain

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
    "subjectClaim": "sub",                 // §1.3 の custom claim 名 (任意)。省略すると email だけで解決する
    "allowedEmailDomains": ["example.co.jp"],
    "adminGroups": [],                     // 明示列挙したグループだけ Cernere role=admin へ昇格 (既定は昇格なし)
    "fetchIdentity": true,                 // get-identity で user_uuid/name/groups を取る (既定 true)
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

`subjectClaim` は任意。設定すると**社員のメールアドレス変更に追従**でき、省略すると
アドレス変更が新規アカウント扱いになる。IdP 移行 (Google Workspace → Entra 等) には
どちらの設定でも email 一致で耐える。

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

`edge_identities` の `cf_user_uuid` / `groups` / `idp_type` が埋まっていることも
確認する (グループを使わない構成なら `groups` は空で正常)。グループを使う構成で
`groups` が空のままなら §1.4 のグループ連携が未設定
(ブラウザで `https://hub.example.com/cdn-cgi/access/get-identity` を開くと、
そのセッションで CF が返す identity をそのまま目視できる)。

---

## 6. 運用上の注意

- **CF Access の policy を緩めると Cernere のアカウントが自動生成される** (`auto` の場合)。
  policy 変更は `allowedEmailDomains` とセットで見直す。
- **退職者のデータは削除する。** IdP 側で無効化すれば CF は通れなくなるが、Cernere 側の
  個人データはそのままなので、棚卸しして消す:

  ```jsonc
  { "module": "edge_idp", "action": "stale_identities", "payload": { "days": 90 } }
  // → email / 表示名 / 最終ログイン日の一覧が返る。退職者を確認して:
  { "module": "edge_idp", "action": "purge_user",
    "payload": { "userId": "...", "confirmEmail": "taro@example.co.jp" } }
  // step-up (passkey) 必須。users / edge_identities / project_data_<key> を削除し、
  // operation_logs は監査のため残す。
  ```

  これにより、同じアドレスを後任者が引き継いでも**前任者のアカウントを掴まない**
  (新規ユーザとして作られる)。逆に削除しないまま放置すると引き継いでしまうので、
  棚卸しは運用に組み込むこと。

- **組織を作成したユーザは purge できない** (`owns_organizations` で拒否される)。
  先に組織の所有権を移譲すること。ユーザを消して組織が道連れになる事故を防ぐための
  仕様なので、拒否されたら移譲してから再実行する。
- CF の署名鍵ローテーションは JWKS 側で自動追従する (未知 `kid` で 1 回だけ再取得)。
- Hub のドメインを変えると AUD Tag も変わる。binding の `audTags` を更新すること。
