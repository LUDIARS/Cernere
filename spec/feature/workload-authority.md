# workload 認証局

- ID: SPEC-WORKLOAD-AUTHORITY
- Cr task: actio:907da54c-c82e-4a3c-83e0-19d330192d52
- 関連 Ex task: actio:7a9649fb-f582-4082-b841-922ba798139b（Cr の所有タスクではない）
- wire 正本: Ex `spec/feature/security-mesh-cr-auth.md`

## 保存・管理境界

`workload_principals` は site/workload 形式の不変 ID と独立 client ID、bcrypt secret hash、失効時刻を持つ。`workload_keys` は主体につき一つの登録済み Ed25519 SPKI 公開鍵と失効時刻を持つ。秘密鍵は受け取らない。鍵交換は旧主体を失効して新しい ID を登録する方式とし、失効済み行は再有効化しない。

`workload_grants` は不変 ID、主体、宛先、action、resource、vault の keys 完全一致 allowlist、失効時刻を持つ。変更は失効と新規作成で行い、発行済み token に権限が後から増えない。`workload_tokens` は SHA256 token hash、公開 jti、主体、宛先、鍵 ID、grant ID、発行・期限・失効時刻のみを保持する。平文 secret / token は保存しない。

管理操作は既存 user WebSocket の `workload_authority` module に限定し、dispatch の session / logged_in 検査と system admin 判定を通す。`register` は `{id, publicKeyPem}` から client credentials を一度だけ返す。`grant` は `{subject,audience,action,resource,keys?}`、失効は `revoke_principal` / `revoke_key` / `revoke_grant` / `revoke_token` に `{id}` を渡す。登録・grant の応答 ID は管理者が記録する。自己登録・自己 grant・再有効化・秘密鍵生成 API は設けない。

## HTTP と失効

Cc の event 認可は `ai-spawn` / `ai-inject` と `thread:<guild_id>:<channel_id>` の完全一致 grant を使用する。ID は1〜20桁の数字に限定し、wildcard・追加セグメント・vault keys を許可しない。HQ設定は引き続き `hq-config` / `service:concordia`。発行時に自己指定で grant を増やすことはできない。

`POST /api/workload/token` は `{client_id,client_secret,audience,action,resource}`、応答は `{access_token}`。`POST /api/workload/introspect` は `{client_id,client_secret,token,audience}`、応答は `{active:false}` または `{active:true,claims}`。入力の未知フィールドは拒否する。発行権限は管理者 DB の完全一致 grant だけから導出する。

token は `wk1.` + 256 bit 乱数の opaque 値。Ex は offline 検証を行わないため PASETO を流用しない。claims は `{kind:'workload',sub,aud,iat,exp,jti,cnf:{public_key},grants:[{action,resource,keys?}]}`。時刻は ISO8601、TTL は60秒。introspection は宛先本人の credentials を検証し、主体・宛先・双方の鍵・grant・token の失効、audience、期限を毎回 DB snapshot で検査する。認可結果はキャッシュしない。既存 project service token と資格情報は別 namespace とし、降格しない。

workload の HTTPS は一般認証と別の待受とする。`CERNERE_TLS_CERT_FILE` / `CERNERE_TLS_KEY_FILE` / `CERNERE_WORKLOAD_TLS_PORT` の 3 つを管理者が揃えたときだけ、workload ルートだけを持つ uWS SSLApp を `LISTEN_PORT` と別のポートで起動する。一部だけの設定・不正ポート・`LISTEN_PORT` と同一ポートは起動構成エラー。一般認証の app は TLS 設定の有無に関わらず常に平文 (`uWS.App`) で既存の REST・WS・CORS・パスを保持し、そこへの workload HTTP 要求は 403 で拒否する。proxy header を TLS 根拠にしない。workload 応答は no-store、body サイズ制限と IP rate limit を適用する。DB 障害は固定503、認証失敗は固定401、token 不成立は inactive。DB 開発ログでも workload SQL パラメータをマスクする。

## 再利用

C14〜C16 の観測 runtime は pinned Lapilli submodule (`07f16292758d8d8cd588b051ca2935cba9c258c4`) の `@ludiars/log-weaver` を使用する。`git submodule update --init --recursive` 後、server dependency を導入し、server build が runtime を先にビルドする。述語は `server/src/workload/contracts` に置き、server rootDir 外の import を避ける。runtime の observe は認証結果を変更せず、引数・credential・token を観測ログへ出さない。許可された隔離 workload suite 70/70 で C14〜C16 の観測証跡を取得し、違反・predicate例外0。実サービス/TLS接続/production DBの受入は未実施。

Drizzle / PostgreSQL、既存 bcrypt credential 関数、SHA256 token hash、Ed25519 公開鍵正規化、AppError、WS 管理者判定を再利用する。project PASETO は principal / grant / revoke 境界が異なるため採用しない。実登録、鍵生成・交換、migration 適用、起動・配備はこの変更では行わない。

## 配備

待受の構成、配備前の migration dry-run (`npm --prefix server run migrate:dry-run`、必ず ROLLBACK)、直前 build と DB スナップショットによる戻し方は [workload-deploy](../setup/workload-deploy.md) に従う。dry-run は起動時の `runMigrations` と同じステートメント分割・冪等スキップ規則を `server/src/db/migration-files.ts` で共有する。
