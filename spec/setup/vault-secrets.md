# Excubitor Vault による秘密情報の管理

Cernere の秘密情報は Excubitor の共有 Vault / プロジェクト Vault に保存します。Excubitor が `cernere` の紐付け名から値を起動プロセスへ注入します。
Cernere は secret store へ直接取得せず、`.env` も生成・読み込みません。`ensureEnv()` は必須値を検証し、不足時は変数名だけで起動を止めます。
署名鍵などの機能固有検証は config / auth の責務です。

## project credential CLI

対象 DB の `DATABASE_URL` と、管理 API の `EXCUBITOR_URL` または `EXCUBITOR_PORT` を注入してから、`server/` で使います。
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
