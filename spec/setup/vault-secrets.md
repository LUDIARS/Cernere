# Excubitor Vault による秘密情報の管理

Cernere の秘密情報は Excubitor の共有 Vault / プロジェクト Vault に保存します。Excubitor が `cernere` の紐付け名から値を起動プロセスへ注入します。
Cernere サーバは secret store へ直接取得せず、`.env` も生成・読み込みません。`ensureEnv()` は必須値を検証し、不足時は変数名だけで起動を止めます。
署名鍵などの機能固有検証は config / auth の責務です。

## 運用スクリプトの環境補完

運用スクリプトは Excubitor が動いている PC で、そのまま実行できます。起動前に管理 endpoint の `EXCUBITOR_URL`、または既存互換の明示 `EXCUBITOR_PORT` を設定します。番号の既定値は持たず、URL が優先です。
Actio の現行 endpoint 実装も URL の注入を必須としており、自動のポート探索は行いません。

| CLI | 必須環境変数 |
| --- | --- |
| register-project / rotate-project-secret | DATABASE_URL, REDIS_URL |
| grant-project-data-sharing | DATABASE_URL, REDIS_URL |
| register-oidc-client | DATABASE_URL |

必須値が不足すると、config / DB / Redis を import する前に `POST /api/v1/secrets/resolve` へ `{ "service": "cernere" }` を送ります。Bearer agent token は次の順序で解決します。

1. `EXCUBITOR_AGENT_TOKEN` の値。
2. `EXCUBITOR_AGENT_TOKEN_PATH` が指定する UTF-8 ファイル。
3. `%APPDATA%/Excubitor/secret-agent.token`。APPDATA がなければ `<homedir>/.config/Excubitor/secret-agent.token`。

指定ファイルが読めない場合は失敗し、別ファイルへフォールバックしません。トークンファイルは Excubitor が管理します。
応答の `source: vault` と全エントリの形式を検証し、必須値が揃う場合だけ未定義の env を補います。取得した値やトークンは表示・保存しません。既存の値は空文字も含めて保持するため、明示した空の必須変数は削除するか修正してください。
必要な値がすでに注入済みなら HTTP 要求もトークン読み取りも行いません（project credential CLI の保存先 endpoint は別途必要です）。

要求は10秒でタイムアウトし、redirect は追いません。401 は `unauthorized`、403 は `keys_not_bound`、404 は `no_mapping`、502 は `fetch_failed`、その他は `http_error`。接続失敗は `unreachable`、応答不正は `invalid_response`、不足が残れば `missing_env` です。未設定 endpoint / token は `no_endpoint` / `no_token` で停止します。エラーには固定分類と既知の必須キー名だけを出し、応答本文・ネストした例外を出しません。

この補完は運用 CLI 専用です。サーバ本体の `server/src/bootstrap.ts` の起動経路と Vault 注入要件は変更しません。

## project credential CLI

管理 API の `EXCUBITOR_URL` または `EXCUBITOR_PORT` を設定し、`server/` で使います。対象 DB / Redis の接続値が未定義なら上記 secret-agent で補います。
URL 指定が優先です。loopback の HTTP origin のみを許容し、未指定時はポートを推測せず失敗します。redirect は追いません。

```bash
npx tsx scripts/register-project.ts --file ./aedilis-schema.json --service excubitor --vault-project <id>
npx tsx scripts/rotate-project-secret.ts --project aedilis --service excubitor --vault-project <id>
```

- `--vault-project <id>`: 既存のプロジェクト Vault ID。省略時は共有 Vault。未知 ID は書き込み前に失敗。
- `--service <code>`: 紐付け先の catalog service code。必須。
- `--env-prefix <PREFIX>`: 既存の環境変数名に合わせる接頭辞。既定は project key の大文字化・非英数字を underscore 化。ただし aedilis は既存の `EXCUBITOR` を維持。
- 保存名: `<PREFIX>_CERNERE_CLIENT_ID` / `<PREFIX>_CERNERE_CLIENT_SECRET`。値は出力しない。

`GET /api/v1/vault` で選択 scope の紐付けを読み、既存名を保持して不足名だけ追記します。
`PUT /api/v1/vault/bindings/<code>` → ID entry → secret entry の順に保存します。プロジェクト指定時は各 PUT に `?project=<id>` を付けます。
すべて成功してから DB に bcrypt hash を保存します。Vault が失敗した場合は DB を更新しません。再有効化時は既存資格情報を維持し、Vault へ配送しません。

## 部分失敗と運用上の境界

Vault API と DB は分散トランザクションではありません。紐付けや ID の保存後に失敗すると、それまでの Vault 更新は残ります。
secret PUT の応答喪失や、その後の DB 保存失敗でも Vault 側だけ更新される可能性があります。失敗時は DB / Vault の状態を確認し、この CLI で再発行して復旧します。平文の参照・ログへの貼り付けは行いません。
同一 service/scope の紐付け PUT は一覧置換 API なので、同時に別の編集操作を行わないでください。
実データ登録・再発行、サービス起動・再起動はこの実装作業では行っていません。

## 互換範囲

`packages/env-cli`、dotenv-cli、他リポの設定は保持します。Cernere 専用 `env-cli.config.ts` は参照調査で外部利用を確認できなかったため撤去しました。
旧 `env:*` コマンドは互換 CLI の入口であり、Cernere の起動手順ではありません。利用するリポジトリ自身の設定を使います。
