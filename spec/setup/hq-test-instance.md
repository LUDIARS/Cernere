# 本社のテスト用 Cernere

本社 (DESKTOP-3HFT33B) の Cernere はテスト用とし、ループバックからの接続だけを受ける (neco 2026-10-09)。
本番の Cernere は Mac (GROMAC、`100.84.227.24:8080`) で、AWS など他拠点のサービスはそちらを使う。

## なぜ分けるか

Excubitor の `cernere_launch_credentials` は、サービスを起動するたびに対象 project の secret を作り直し、
`credential_generation` を 1 つ上げる。本社のテスト用 GLAB が本番と同じ DB の EducationLab を発行させると、
AWS の GLAB が `project.login.failed / invalid credentials` (HTTP 401) になる (2026-10-09 に発生)。
テスト用の起動は、本番と別の DB を持つテスト用 Cernere に向ける。

## 構成

| 項目 | 本社のテスト用 Cernere | 本番 (Mac) |
|---|---|---|
| 待受 | `LISTEN_HOST=127.0.0.1` | 未設定 (全インターフェース) |
| DB | 共有 Postgres の `cernere_test` (空から作る) | 共有 Postgres の `cernere` |
| Redis | 本番と別の DB 番号 (例 `/1`) | 既定 |
| 中身 | migration が作る初期行 + テストに要る最小限 | 本番データ |

本番の利用者データは複製しない (個人情報を持ち込まない)。テストの利用者はテスト用 Cernere で新規に作る。

## 設定手順 (本社)

1. 共有 Postgres に `cernere_test` を作る。所有者は本番の Cernere と同じサービス role にする
   (superuser で作ると migration 後にサービス role から触れなくなる)。
2. 本社の Excubitor Vault で、Cernere の `DATABASE_URL` を `cernere_test` へ、`REDIS_URL` を別の DB 番号へ向ける。
   Vault は catalog / runtime config より優先されるので、拠点 (本社) の Vault だけを変える。
3. 本社の Excubitor の Cernere の runtime config に `LISTEN_HOST=127.0.0.1` を入れる。catalog は全拠点共有なので書かない。
4. Excubitor で Cernere を再起動する。起動時に migration が `cernere_test` へ流れる。
5. 起動用資格情報の発行元 (`excubitor` project) の client_id / secret を、本社の Excubitor が持つ
   `EXCUBITOR_CERNERE_CLIENT_ID` / `EXCUBITOR_CERNERE_CLIENT_SECRET` と一致させる。
   空の DB では migration 028 がランダム値で作るため、そのままでは発行が 401 になる。
6. 本社のテスト用 GLAB の runtime config で `CERNERE_BASE_URL` を `http://127.0.0.1:8080` に上書きする
   (topology は本番の Mac を配るため)。

## 確認

- `netstat` / `Get-NetTCPConnection` で 8080 が `127.0.0.1` だけで待ち受けていること。
- 本番 (Mac) の Cernere のログに、本社のテスト用 GLAB からの `project.login` が出ないこと。
- 起動ログが `[server] Listening on http://127.0.0.1:8080` になっていること。
