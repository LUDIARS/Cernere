# Cernere を AWS 拠点へ移す (データ移行込み)

## 経緯と決定 (neco 2026-10-11)

- 本番 Cernere は GROMAC (Mac、Tailscale 100.84.227.24 / Ex ピア macat.local) で動いていたが、
  2026-10-11 に backend / frontend とも停止。GROMAC は 8GB に対し空きが約 120MB
  (OrbStack 1.6GB ほか) で、担当 61 サービス中 35 が停止していた。cr.ai-run-do.com は 1033。
- neco 決定: Cernere は AWS 拠点 (ip-172-31-8-250、Tailscale 100.94.102.46、Ex ピア
  fbc33b04-…) で動かす。データ (Postgres `cernere`) も AWS へ移す。
- Redis のセッションは移さない (TTL 7 日の一時状態。移行後は全員再ログイン)。

## AWS 拠点の現状 (2026-10-11 調査)

- RAM 1.8GB (空き約 0.9GB)、disk 空き 8.4GB。GLAB と Excubitor が常駐。
- docker `cernere-postgres` (postgres:17-alpine、:5432) と `cernere-redis` (:6379) が 5 か月前から稼働。
  DB `cernere` の中身は 2026-04 時点の古いもの (users 1 行) で、正本ではない。
- 0.0.0.0:8080 は synergos-relay が使用中 → Cernere は 8080 を使えない。
- pg_dump / pg_restore は host に無く、`cernere-postgres` コンテナ内に 17.9 がある。
- 移行元 GROMAC の Postgres は OrbStack の `infra-postgres-1` (17.11、tailnet 上 trust 認証)。
  host に pg_dump は無い。AWS から 100.84.227.24:5432 へ到達できる。

## 方針

### ポート

backend の catalog port を **8080 → 8086** に変える (全 catalog と AWS で未使用を確認済み)。
Cernere の正本拠点は AWS だけになるので、拠点ごとの上書きではなく catalog 自体を変える。
`provides` の `CERNERE_URL` 等も追随する。`cernere-frontend` の `VITE_BACKEND_URL` と health も更新。
本社テスト用 (`cernere-test` 8090) は変えない。

### frontend

AWS の RAM が小さいので Vite dev server ではなく、setup でビルドした静的ファイルを
`vite preview` (port 5173、`/api` 等の backend 経路は preview proxy で 8086 へ) で配る。
本社など dev で使う拠点の手順を壊さないこと (dev 用 script は残し、catalog の command を preview に切り替えるか、
拠点差を設定で吸収する。どちらにしたかを setup 文書へ書く)。

### DB 接続先

Vault の `cernere` の値は service code 単位で全拠点へ配られる。移行後の正本は AWS だけなので、
Vault の `DATABASE_URL` / `REDIS_URL` を AWS のコンテナ (127.0.0.1:5432 / :6379) に向ける
(運用作業。値の変更は人間または Vault 操作の許可範囲で行う。このリポでは値を持たない)。

### データ移行 (service-bootstrap 契約の export / import を実装する)

`excubitor.bootstrap.json` の `data.export` / `data.import` を `data-unavailable.mjs` から実装へ差し替える。

- `scripts/site/export-data.mjs --output <abs>`
  - 停止中の Cernere の DB を論理ダンプ (`pg_dump -Fc`) し、1 ファイルの bundle にする。
  - bundle = 先頭にヘッダ JSON (service=`cernere`、formatVersion、作成日時、pg サーバ版、表ごとの行数、
    dump の sha256) + pg_dump custom 形式本体。Redis は含めない (ヘッダに明記)。
  - pg_dump の実行手段は host 依存なので設定で選ぶ: host の `pg_dump` (PATH または明示パス) か、
    `docker exec <container> pg_dump` (docker の実行ファイルパスとコンテナ名を設定)。設定は
    `EXCUBITOR_SERVICE_CONFIG_JSON` (拠点ごとの runtime config) から読み、env でも上書きできる。
    接続先は `DATABASE_URL`。既存出力があれば失敗。秘密 (DSN の password) を出力しない。
- `scripts/site/import-data.mjs --input <abs> --sha256 <hex>`
  - sha256・service・formatVersion を検証。dump の sha256 もヘッダと照合。
  - 復元先に既存データがある場合は、既存 DB を `cernere_backup_<UTC 日時>` へ rename して保全してから
    新しい `cernere` を作り `pg_restore --no-owner --role=<接続 role>` する (サービス所有の検証済み手順)。
  - 復元後に表ごとの行数をヘッダと照合。失敗時は新 DB を削除して backup を元の名前へ戻す。
  - 実行手段は export と同じ設定 (AWS では `docker exec -i cernere-postgres`)。
- どちらも 15 分以内、子プロセスを残さない、非 0 で失敗、shell を介さない。
- 単体テスト: ヘッダの組立と検証、sha 不一致・service 不一致・既存出力での失敗、
  rename → restore → 行数照合 → 失敗時ロールバックの手順 (DB 実行は注入した runner で fake)。

### 公開 URL

`cr.ai-run-do.com` の Cloudflare Tunnel ルートを GROMAC の tunnel から AWS の tunnel
(`127.0.0.1:5173`) へ付け替える (Ex の CF ブローカーで行う運用作業)。
本社 Ex の `EXCUBITOR_TOPOLOGY_HOSTS` の `cernere=` を AWS の Tailscale IP へ変える (運用作業)。

## 切替手順 (マージ後の運用)

1. AWS へ Ex 経由で bootstrap (start:false) → setup。
2. GROMAC の Cernere は停止中のまま、GROMAC Ex に data-export を依頼 → sha256 を控える。
3. Taildrop で AWS へ送り、AWS Ex に data-import を依頼。
4. Vault の DATABASE_URL / REDIS_URL、本社 topology、CF ルートを AWS へ。
   AWS Ex の `EXCUBITOR_TOPOLOGY_HOSTS` に `cernere=` / `cernere-frontend=` が残っていれば消す
   (AWS では Cernere は同居なので localhost が正しい。残すと GLAB 等が他拠点を指す。2026-10-12 の problem log)。
5. AWS Ex から cernere → cernere-frontend を start。health と cr.ai-run-do.com のログインを確認。
   その後、`CERNERE_BASE_URL` / `CERNERE_FRONTEND_URL` を spawn 時に読む依存サービス (GLAB) を再起動し、
   glab.ai-run-do.com のログインも確認する。
6. GROMAC 側の Cernere は autostart を外し停止のまま。元データと受信ファイルは確認完了まで消さない。

## 受入条件

- export / import / setup がこの文書どおりに動き、テストが通る。
- catalog の port 変更が他サービスの catalog と衝突しない。
- 実データでの切替は上記手順で、許可された範囲で行う (このリポの PR は手順の実行を含まない)。
