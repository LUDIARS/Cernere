# 本社のテスト用 Cernere

本社 (DESKTOP-3HFT33B) のテスト用 Cernere は、ループバックからの接続だけを受ける (neco 2026-10-09)。
本番の Cernere は Mac (GROMAC、`100.84.227.24:8080`) で、AWS など他拠点のサービスはそちらを使う。

## なぜ分けるか

Excubitor の `cernere_launch_credentials` は、サービスを起動するたびに対象 project の secret を作り直し、
`credential_generation` を 1 つ上げる。本社のテスト用 GLAB が本番と同じ DB の EducationLab を発行させると、
AWS の GLAB が `project.login.failed / invalid credentials` (HTTP 401) になる (2026-10-09 に発生)。
テスト用の起動は、本番と別の DB を持つテスト用 Cernere に向ける。

## 別の service code にする理由

本社の Excubitor Vault は他拠点の取得元でもある。ローカルに紐付けを持たない拠点は本社から値を取り
(2026-10-09 時点で Mac が `cernere`、AWS が `glab`)、Vault の値は service code 単位で決まる。
`cernere` / `glab` の Vault を本社用に変えると本番に配られるため、テスト用は別の service code にする。

Excubitor の runtime config は `EXCUBITOR_SERVICE_CONFIG_JSON` という JSON 1 本で渡り、個別の env にはならない。
また GLAB の起動用資格情報は Excubitor が子プロセス起動前に Vault の `CERNERE_BASE_URL` へ発行するので、
サービス側で接続先を上書きしても発行先は変わらない。

## 構成

| 項目 | 本社のテスト用 | 本番 |
|---|---|---|
| Cernere | `cernere-test` (`127.0.0.1:8090`) | `cernere` (Mac、`:8080`) |
| ログイン画面 | `cernere-frontend-test` (`127.0.0.1:5174`) | `cernere-frontend` |
| GLAB | `glab-test` (GLAB カタログ、`:5188`) | `glab` (AWS) |
| Cernere DB | 共有 Postgres の `cernere_test` (空から作る) | `cernere` |
| GLAB DB | 共有 Postgres の `glab_test` | `glab` |
| Redis | 本番と別の DB 番号 | 既定 |
| 秘密 | テスト用に新しく作った値 (JWT・secret box 鍵・発行元の client) | 本番の値 |

値はすべて本社 Excubitor Vault のテスト用 project (`CernereTest`) に置き、`cernere-test` と `glab-test` だけを紐付ける。
本番の秘密は読まず、複製もしない。本番の利用者データも複製しない (個人情報を持ち込まない)。

## 設定手順 (本社)

1. 共有 Postgres に `cernere_test` と `glab_test` を作る。所有者はそれぞれ本番の `cernere` / `glab` と同じ role にする
   (superuser で作ると migration 後にサービス role から触れなくなる)。
2. Vault にテスト用 project `CernereTest` を作り、次を入れる。
   - `cernere-test`: `DATABASE_URL` (cernere_test)、`REDIS_URL` (別 DB 番号)、`LISTEN_HOST=127.0.0.1`、
     `JWT_SECRET` と `CERNERE_SECRET_KEY` (新しい乱数)
   - `glab-test`: `CERNERE_BASE_URL=http://127.0.0.1:8090`、`CERNERE_FRONTEND_URL=http://127.0.0.1:5174`、
     `GLAB_DATABASE_URL` (glab_test)、`EXCUBITOR_CERNERE_CLIENT_ID` / `EXCUBITOR_CERNERE_CLIENT_SECRET` (新しい乱数)
3. Excubitor で `cernere-test` を起動する。起動時に migration が `cernere_test` へ流れる。
4. `cernere_test` の `managed_projects` で `key = 'excubitor'` の `client_id` と `client_secret_hash`
   (`crypt(secret, gen_salt('bf', 12))`) を、手順 2 の `EXCUBITOR_CERNERE_*` に合わせる。
   migration 028 はランダム値で作るため、そのままでは発行が 401 になる。
5. `cernere-frontend-test` を起動し、テスト用の利用者を作る。最初の利用者が管理者になる。
   起動用資格情報の発行は管理者を 1 人以上要求するので、これが済むまで `glab-test` は起動できない。
6. `glab-test` を起動する。

本社の `cernere` と `glab` は起動しない (`autostart: false`)。

## 確認

- 8090 / 5174 が `127.0.0.1` だけで待ち受けていること (`Get-NetTCPConnection -LocalPort 8090`)。
- 起動ログが `[server] Listening on http://127.0.0.1:8090` になっていること。
- 本番 (Mac) の Cernere のログに、本社の `glab-test` からの `project.login` が出ないこと。
- 本社の Excubitor ログの「vault values delivered to peer」に `cernere-test` / `glab-test` が出ないこと。
