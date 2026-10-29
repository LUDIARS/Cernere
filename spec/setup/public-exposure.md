# 外部公開する本番 Cernere の設定 (AWS 拠点)

`cr.ai-run-do.com` は Cloudflare Tunnel 経由で誰でも到達できる。Cloudflare Access は前に置かない
(利用者のログイン画面そのものなので)。ここでは、その前提で本番 (`cernere` / `cernere-frontend`) に
揃えておく設定を、リポで持つもの・拠点で行うもの・人間が行うものに分けて書く。
経緯は 2026-10-29 の攻撃可能性調査 (neco 指示)。

## 経路

```
利用者 → Cloudflare → cloudflared (AWS) → cernere-frontend 127.0.0.1:5173 (frontend/serve/index.mjs)
                                              ├─ 静的ファイル (frontend/dist)
                                              └─ /api /auth /ws/project /.well-known → cernere 127.0.0.1:8086
本社など他拠点のサービス → tailnet → cernere <拠点の tailnet IP>:8086
cernere → cernere-postgres 127.0.0.1:5432 / cernere-redis 127.0.0.1:6379 (要パスワード)
```

## リポで持つもの (excubitor.catalog.yaml)

| 項目 | 値 | 理由 |
|---|---|---|
| `cernere` の command | `node --run start:server` (server/dist) | `tsx watch` は開発用。コードの反映は deploy (pull → setup のビルド → 再起動) |
| `CERNERE_ENV` | `production` | 500 の内部メッセージ・詳細ログ・`CERNERE_IDENTITY_VERIFICATION_DISABLED` を本番で無効にする。`NODE_ENV` は setup の npm install から devDependencies を外すので使わない |
| `CERNERE_TRUSTED_PROXIES` | `127.0.0.1,::1` | ループバックから来た要求だけ `CF-Connecting-IP` を接続元とする。これが無いと IP 単位のレート制限が全利用者で 1 枠になる |
| `cernere-frontend` の command | `node serve/index.mjs` | `vite preview` は本番用ではない。待受は `127.0.0.1` だけ |

コード側の対策: 本文上限 (既定 256 KiB、`/auth` WS 1 MiB、未昇格ゲスト 16 KiB)、passkey ログイン開始の
レート制限を「接続元」と「email × 接続元」で数える (email 単独で数えると他人を締め出せる)、
未登録 email にも同じ形の allowCredentials を返し `challengeOwner` に userId を載せない (登録有無と内部 ID を引かせない)。

## Vault の値 — どこに入れるか

AWS の cernere は本社 Vault から値を受け取り、拠点固有の値だけを **AWS の Excubitor の拠点上書き**
(`overrides.cernere`、Excubitor spec/feature/vault.md の SPEC-EX-VAULT-SITE-OVERRIDE) で持つ。
拠点固有の値を本社側に入れると、AWS では古い上書きが後勝ちで使われて効かないうえ、cernere を担当する
他の拠点にも配られる。

| キー | 入れる場所 | 値 | 備考 |
|---|---|---|---|
| `LISTEN_HOST` | AWS の拠点上書き | `127.0.0.1,::1,<AWS の tailnet IP>` | 同居サービス (GLAB 等) と tailnet だけに開く。本番で未設定なら起動を止める |
| `REDIS_URL` | AWS の拠点上書き | `redis://:<パスワード>@127.0.0.1:6379` | パスワードは AWS の `~/.config/cernere/datastores.env` の `REDIS_PASSWORD` |
| `CERNERE_IDENTITY_VERIFICATION_DISABLED` | 本社の `cernere` の紐付けから**外す** | — | 残すと `CERNERE_ENV=production` で起動時に例外になり、Cernere が起動しない |
| `CERNERE_ENV` / `CERNERE_TRUSTED_PROXIES` / `NODE_ENV` | **入れない** | — | catalog が持つ。Vault に入れると catalog の値より優先されて崩れる |

## export 系の口の scope (反映前に宣言する)

passkey の公開鍵一括取得・名簿・スキーマ取得・kiosk の authCode 交換は、project token に加えて
呼出元 project の `service_scopes` (管理者所有) に次の scope の宣言を要る。宣言の無い project の token は 403 になる。
以前は有効な project token なら何でも通っていた (どのサービスの client_secret でも全利用者の台帳を引けた)。

| 口 | scope | 使う project (2026-10 時点) |
|---|---|---|
| `GET /api/auth/passkey/export` | `passkey:export` | Ostiarius |
| `GET /api/identity/roster` | `identity-roster:read` | Ostiarius |
| `POST /api/auth/code/exchange` | `auth-code:kiosk-exchange` | Ostiarius |
| `GET /api/admin/projects/schema-export` | `project-schema:read` | Foedus |

反映する前に、Cernere の管理画面でこれらの project の service_scopes に宣言を足す (管理者ユーザーの token は scope 無しで通る)。

## 手順 (順番どおりに行う)

1. **本社**: `cernere` の紐付けから `CERNERE_IDENTITY_VERIFICATION_DISABLED` を外す。
   ```sh
   node scripts/site/public-hardening/hq-vault-unbind.mjs
   ```
2. **AWS**: 拠点のシェル (Excubitor の terminal profile 経由でよい) で `scripts/site/public-hardening/aws-site.sh` を流す。
   何度流しても同じ結果になり、秘密の値は表示しない。行うことは次の 4 つ。
   - Redis パスワードを拠点で作る (`~/.config/cernere/datastores.env`、0600)
   - 拠点上書きに `LISTEN_HOST` / `REDIS_URL` を入れ、`overrides.cernere` に名前を足す
   - Postgres / Redis をループバック待受 + Redis パスワード必須で作り直す (データは既存 volume。
     定義は `deploy/datastores/docker-compose.yaml` と同じもの)
   - cloudflared の Tunnel トークンをプロセス引数から `--token-file` へ移す (接続を確認できなければ元に戻す)。
     Tunnel は AWS の全公開サービス (GLAB 等) が共有するので、切り替え直後に各ホスト名の到達を確認する
   Redis はパスワード必須になるので、**この直後に 3 まで進める** (間が空くと、動いている Cernere が NOAUTH で止まる)。
3. **AWS**: Excubitor の peer operation で `cernere` → `cernere-frontend` の順に deploy (setup でビルドされる)。
   `http://127.0.0.1:8086/health` と `https://cr.ai-run-do.com/` を確認する。

戻すときは、旧 compose (Redis はパスワード無し・全インターフェース待受) で `docker compose up -d postgres redis`、
拠点上書きから `LISTEN_HOST` / `REDIS_URL` を外し、cloudflared の drop-in
(`/etc/systemd/system/cloudflared.service.d/token-file.conf`) を消して `systemctl daemon-reload && systemctl restart cloudflared`。

## 人間が行うこと (この環境から権限が無いもの)

- **セキュリティグループ**: 受信は 22 だけにし、22 も管理元 IP か Tailscale 経由に限定する。
  5173 / 8086 / 5432 / 6379 / 9000 / 9001 は開けない (Tunnel は外向き接続だけで動く)。
- **Tailscale ACL**: tailnet から AWS の 8086 に来てよい端末を、Cernere を使うサービスの拠点に絞る。
  5432 / 6379 はループバック待受になるので tailnet からは届かない。
- **Cloudflare (cr.ai-run-do.com)**: WAF Managed Rules を有効にし、`/api/auth/*`・`/api/federation/*`・`/auth` (WebSocket) に
  レート制限ルールを入れる (例: 1 IP あたり 1 分 60 回)。IPv6 は /64 で数える設定にする (アプリ側も /64・/48 で数える)。
  本文サイズはアプリ側で 256 KiB に制限済み。
- **監視**: Excubitor か CloudWatch で 401 / 429 / 500 の急増を通知する。auth ログ (`server/logs/auth-*.log`) の保管期間を決める。

