# workload 認証局の配備と戻し方

仕様: [workload-authority](../feature/workload-authority.md)

## 待受の構成

| 待受 | ポート | 方式 | 載るルート |
|---|---|---|---|
| 一般認証 | `LISTEN_PORT` | 平文 HTTP / WS (`uWS.App`) | 既存の認証 REST・`/auth` 等の WS・OIDC・`/health`。`/api/workload/*` は常に 403 |
| workload | `CERNERE_WORKLOAD_TLS_PORT` | HTTPS (`uWS.SSLApp`) | `POST /api/workload/token`・`POST /api/workload/introspect` と 404 のみ |

- workload 待受は `CERNERE_TLS_CERT_FILE`・`CERNERE_TLS_KEY_FILE`・`CERNERE_WORKLOAD_TLS_PORT` の 3 つが揃ったときだけ起動する。全て未設定なら workload 待受は無く、一般認証は従来どおり動く。
- 1〜2 個だけの設定、不正なポート、`LISTEN_PORT` と同じポートは、migration や接続より前に起動構成エラーで停止する。
- TLS 設定を入れても一般認証の待受・パス・CORS は変わらない。既存クライアント、proxy の転送先、ヘルスチェックは変更不要。
- TLS の根拠は SSLApp で受けたことだけ。proxy header (`X-Forwarded-Proto` 等) では workload を許可しない。
- SSLApp を作るのは `server/src/http/workload-listener.ts` だけ。待受構成の解釈は `server/src/http/workload-listener-config.ts`。

## 配備前の確認

1. 戻し先を確保する: 直前に稼働していた build (コミット ID と `server/dist`) を控え、対象 DB のスナップショット (`pg_dump -Fc` またはボリュームスナップショット) を取得する。
2. スナップショットから復元した確認用 DB に `DATABASE_URL` を向け、`npm --prefix server run migrate:dry-run` を実行する。
   - 未適用 migration を 1 トランザクションで起動時と同じ規則 (ステートメント分割・冪等スキップ) で実行し、必ず `ROLLBACK` する。`COMMIT` せず `_migrations` にも記録しない。
   - `lock_timeout` は 5 秒。稼働中 DB に向けても長時間ロックは握らないが、DDL は短時間の排他ロックを取るため、原則として確認用 DB で実行する。
   - 終了コード: `0` 全て適用可能 / `1` 失敗 (migration 名・SQLSTATE・該当文を表示) / `2` トランザクション内で実行できない文 (`CONCURRENTLY`、`VACUUM`、`ALTER TYPE ... ADD VALUE`、トランザクション制御文など) を含むため何も実行せず停止。
   - `2` の migration は dry-run で検査できない。手動で確認用 DB に適用して確かめてから配備する。
3. workload を有効にする場合は、証明書・鍵ファイルの配置と `CERNERE_WORKLOAD_TLS_PORT` の公開経路 (Ex からの到達) を確認する。一般認証の proxy 設定は触らない。

起動時の `runMigrations()` は失敗するとサービス全体が起動しないため、上記 1〜2 を配備の必須手順とする。

## 失敗時の戻し方

| 状況 | 戻し方 |
|---|---|
| 起動時に migration が失敗した | 起動時の適用は文ごとに確定するため、失敗した migration の失敗文より前の文は適用済みで、`_migrations` には記録されない (次回起動で冪等に再実行される)。直前 build に戻して起動し、原因を dry-run で再現してから修正版を配備する。途中適用が旧 build と矛盾する場合だけ配備前スナップショットから復元する。 |
| migration 適用後に不具合が出た | 直前 build に戻す。追加 migration は追加のみ (`CREATE ... IF NOT EXISTS`) なので旧 build はそのまま動く。データ不整合があるときだけ配備前スナップショットから復元する (復元後に入った書込みは失われるため、復元は人間の判断で行う)。 |
| workload TLS 設定で起動しない | 3 つの workload TLS 設定を全て外すか全て揃える。一般認証は TLS 設定に依存しない。 |
| workload 待受だけ listen に失敗した | ポート競合・証明書パスを確認する。listen 失敗はプロセスを停止するので、急ぎの場合は workload TLS 設定を全て外して一般認証だけで再起動する。 |

DB の削除系操作 (`DROP TABLE` 等) による戻しは行わない (migration ルール)。
