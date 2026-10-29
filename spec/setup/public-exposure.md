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

## Vault (`cernere`) に入れる値 — 人間が Excubitor の画面で行う

| キー | 値 | 備考 |
|---|---|---|
| `LISTEN_HOST` | `127.0.0.1,::1,<拠点の tailnet IP>` | 同居サービス (GLAB 等) と tailnet だけに開く。tailnet IP は拠点差なので catalog に書かない |
| `REDIS_URL` | `redis://:<パスワード>@127.0.0.1:6379` | パスワードは AWS の `/home/ubuntu/.config/cernere/datastores.env` の `REDIS_PASSWORD` |
| `CERNERE_IDENTITY_VERIFICATION_DISABLED` | **削除** | 残すと `CERNERE_ENV=production` で起動時に例外になり、Cernere が起動しない |

## 拠点 (AWS) で行うこと

1. Redis パスワードを拠点で作る (値を通信路・ログに出さない)。
   ```sh
   install -d -m 700 /home/ubuntu/.config/cernere
   umask 077; printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" > /home/ubuntu/.config/cernere/datastores.env
   ```
2. Vault を上の表のとおり更新する (人間)。
3. Postgres / Redis をループバック待受 + パスワード付きで作り直す (データは既存 volume のまま)。
   ```sh
   cd /var/share/LUDIARS/Cernere
   docker stop cernere-redis cernere-postgres && docker rm cernere-redis cernere-postgres
   docker compose -p cernere -f deploy/datastores/docker-compose.yaml \
     --env-file /home/ubuntu/.config/cernere/datastores.env up -d
   ss -ltn | grep -E ':(5432|6379) '   # 127.0.0.1 だけになっていること
   ```
   旧定義は `/home/ubuntu/ludiars/Cernere/docker-compose.yaml` (古い checkout)。戻すときはそちらで `docker compose up -d postgres redis`。
4. Excubitor の peer operation で `cernere` → `cernere-frontend` の順に deploy (setup でビルドされる)。
   `http://127.0.0.1:8086/health` と `https://cr.ai-run-do.com/` を確認する。
5. cloudflared の Tunnel トークンをプロセス引数から外す (同じホストの全ユーザーが `ps` で読めるため)。
   cloudflared 2025.4 以降の `--token-file` を使う。
   ```sh
   sudo install -d -m 700 /etc/cloudflared
   # 現在の ExecStart の --token の値を /etc/cloudflared/tunnel-token (0600 root) へ移す
   sudo systemctl edit cloudflared   # ExecStart= を空にしてから --token-file /etc/cloudflared/tunnel-token で再定義
   sudo systemctl restart cloudflared
   ```
   Tunnel は AWS の全公開サービス (GLAB 等) が共有するので、切り替え直後に各ホスト名の到達を確認する。

## 人間が行うこと (この環境から権限が無いもの)

- **セキュリティグループ**: 受信は 22 だけにし、22 も管理元 IP か Tailscale 経由に限定する。
  5173 / 8086 / 5432 / 6379 / 9000 / 9001 は開けない (Tunnel は外向き接続だけで動く)。
- **Tailscale ACL**: tailnet から AWS の 8086 に来てよい端末を、Cernere を使うサービスの拠点に絞る。
  5432 / 6379 はループバック待受になるので tailnet からは届かない。
- **Cloudflare (cr.ai-run-do.com)**: WAF Managed Rules を有効にし、`/api/auth/*` と `/api/federation/*` に
  レート制限ルールを入れる (例: 1 IP あたり 1 分 60 回)。本文サイズはアプリ側で 256 KiB に制限済み。
- **監視**: Excubitor か CloudWatch で 401 / 429 / 500 の急増を通知する。auth ログ (`server/logs/auth-*.log`) の保管期間を決める。

