# Cernere セットアップ

| 目的 | 設定資料 |
|---|---|
| サーバーを起動する | [server-bootstrap.md](server-bootstrap.md) |
| 秘密情報の保存と注入 | [vault-secrets.md](vault-secrets.md) |
| 設定キーを調べる | [config-reference.md](config-reference.md) |
| PASETO 署名鍵を管理する | [paseto-keys.md](paseto-keys.md) |
| サービスを登録する | [service-registration.md](service-registration.md) |
| OIDC provider を設定する | [oidc-provider.md](oidc-provider.md) |
| Google OIDC を設定する | [google-oidc.md](google-oidc.md) |
| workload 認証局を配備する・戻す | [workload-deploy.md](workload-deploy.md) |

PostgreSQL / Redis が利用でき、Excubitor の共有・プロジェクト Vault に必要値が登録されていることを前提にします。
`cernere` に紐付いた名前の値を Excubitor が起動時に注入します。Cernere 自身は secret store へ取得しに行きません。不足時は起動を止めます。
`.env.example` は設定名の参考資料です。Cernere の起動では `.env` 生成や dotenv 読み込みを使いません。
他リポ向けの `packages/env-cli` は互換用として残しています。
