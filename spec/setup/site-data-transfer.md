# 拠点間のデータ移行 (data-export / data-import)

Excubitor の `data-export` / `data-import` が呼ぶ Cernere 所有の手順。契約の正本は Castra の
`.agents/skills/service-bootstrap/SKILL.md`、移行計画は [../plan/2026-10-11-aws-site-migration.md](../plan/2026-10-11-aws-site-migration.md)。

## 入口と実体

| 入口 (`excubitor.bootstrap.json`) | 実体 |
|---|---|
| `scripts/site/export-data.mjs --output <絶対パス>` | `server/scripts/site-data/export-cli.ts` |
| `scripts/site/import-data.mjs --input <絶対パス> --sha256 <64 桁 hex>` | `server/scripts/site-data/import-cli.ts` |

入口は setup が入れた server の `tsx` を `node --import` ローダにして TypeScript を実行する (shell 無し)。
server の依存が無ければ「setup を先に流す」と出して非 0 で止まる。
`DATABASE_URL` は他の CLI と同じく注入済み env、無ければ Excubitor の secret agent (`cernere` の Vault 紐付け) から取る。
出力は分類済みのエラーコードと表名・件数だけで、DSN・password・行データは出さない。

## bundle 形式 (formatVersion 1)

```
CERNERE-DATA-BUNDLE\n
{"service":"cernere","formatVersion":1,"createdAt":"…","postgres":{"serverVersion":"17.x","database":"cernere"},
 "tables":{"public.users":12,…},"dump":{"format":"pg_dump-custom","sha256":"…","bytes":…},"excluded":["redis"]}\n
<pg_dump -Fc の本体>
```

- ヘッダは 1 行の JSON。`tables` は `information_schema` の BASE TABLE ごとの行数 (`schema.table`)。
- Redis (セッション、TTL 7 日) は含めない。移行後は全員が再ログインする。

## export

1. 出力先と作業ファイル `<output>.pgdump.partial` が既にあれば失敗する。
2. 行数を数え、`pg_dump --format=custom` を取り、もう一度行数を数える。差があれば書き込み中とみなして失敗する
   (`database_changed`)。サービスを止めてから実行すること。
3. dump の sha256 を入れたヘッダを付けて、出力を排他作成で書く。作業ファイルは成否にかかわらず消す。

## import

1. 入力が通常ファイルであること、ファイル全体の sha256 が `--sha256` と一致することを確認する。
2. ヘッダの `service=cernere`・`formatVersion=1` を検証し、dump 部分の sha256 / bytes をヘッダと照合する。
   ここまでで DB には触れない。
3. 復元先 (`DATABASE_URL` の DB 名) が既にあれば `<db>_backup_<UTC YYYYMMDD_HHMMSS>` へ rename して保全する。
4. 新しい DB を作り `pg_restore --no-owner --role=<接続 role> --exit-on-error` で復元する。
5. 表ごとの行数をヘッダと照合する。
6. 4〜5 で失敗したら新 DB を DROP し、退避した DB を元の名前へ戻す。戻せない場合は `rollback_failed`
   と退避名を出して止まる (退避 DB は消さない)。成功時も退避 DB は残る。消すのは確認後に人が行う。

rename と DROP は接続中のセッションがあると失敗する。Cernere は停止しておくこと。
接続 role には `CREATE DATABASE` と対象 DB の `ALTER DATABASE … RENAME` (所有者) の権限が要る。

## pg_dump / pg_restore の実行手段

SQL (行数・rename・create) はホストから `DATABASE_URL` で直接行う。dump / restore のツールだけ拠点ごとに選ぶ。
Excubitor の runtime config (`EXCUBITOR_SERVICE_CONFIG_JSON`) の `dataTransfer` で設定し、env で項目ごとに上書きできる。

| `dataTransfer` | env | 既定 | 意味 |
|---|---|---|---|
| `pgTools` | `CERNERE_PG_TOOLS` | `host` | `host` = ホストの pg_dump / pg_restore、`docker` = `docker exec -i <container>` |
| `pgBinDir` | `CERNERE_PG_BIN_DIR` | (PATH) | host のときのツールのディレクトリ (絶対パス) |
| `docker` | `CERNERE_PG_DOCKER` | `docker` | docker の実行ファイル (名前か絶対パス) |
| `container` | `CERNERE_PG_CONTAINER` | `cernere-postgres` | docker のときのコンテナ名 |
| `host` / `port` | `CERNERE_PG_CONTAINER_HOST` / `CERNERE_PG_CONTAINER_PORT` | `DATABASE_URL` の host / port | コンテナ内から見た接続先 |

password は argv に載せず、`PGPASSWORD` 環境変数で渡す (docker は `-e PGPASSWORD` で転送)。

例: AWS (`cernere-postgres` コンテナに pg 17 がある) は `{"dataTransfer":{"pgTools":"docker","container":"cernere-postgres"}}`。
GROMAC (OrbStack の `infra-postgres-1`) は `{"dataTransfer":{"pgTools":"docker","docker":"<docker の絶対パス>","container":"infra-postgres-1"}}`。
pg_restore は dump を作った pg_dump 以上の版を使う。

## 時間と後始末

ツールの実行は全体で 13 分の予算で打ち切る (Excubitor の 15 分上限より前に後始末と rollback を終えるため)。
SIGTERM / SIGINT を受けたら起動中のツールを kill して非 0 で終わる。docker の場合に kill するのは docker CLI で、
コンテナ内の pg_dump / pg_restore は stdout / stdin の切断で止まる。中断された import の新 DB は rollback の対象外なので、
`<db>_backup_*` の有無を確認してから手で戻す。
