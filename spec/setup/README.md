# Cernere 用途別セットアップガイド

Cernere は LUDIARS の認証プラットフォーム & データリレーサーバーであり、設定軸が複数 (起動 / 秘密管理 / 署名鍵 / サービス登録) に分かれる。本ディレクトリは「何をしたいか」起点で必要な設定だけに辿り着けるようにした用途別ガイドである。

> 設定値の**正本**は `../../.env.example`・`../../env-cli.config.ts`・`server/src/config.ts`。本ガイドは「どのキーを・なぜ・どの順で」設定するかを案内する位置づけで、キーの羅列は [config-reference.md](config-reference.md) に集約する (DRY)。

## 用途別インデックス

| やりたいこと | ガイド | 主な設定軸 |
|---|---|---|
| Cernere サーバを起動したい (dev / prod / standalone) | [server-bootstrap.md](server-bootstrap.md) | `DATABASE_URL` / `REDIS_URL` / `LISTEN_PORT` / `JWT_SECRET` / `FRONTEND_URL` |
| 秘密情報を Infisical で集中管理したい | [infisical-secrets.md](infisical-secrets.md) | `.env.secrets` / `INFISICAL_*` / `npm run env:*` |
| project-token の Ed25519 署名鍵を用意したい | [paseto-keys.md](paseto-keys.md) | `CERNERE_PASETO_SECRET_KEY` / `_PUBLIC_KEY` / `_KID` / `_PREVIOUS_PUBLIC_KEYS` |
| 別サービスを Cernere に登録 / 連携させたい | [service-registration.md](service-registration.md) | `managed_projects` (client_id/secret) / `/api/auth/project-token` / OAuth / peer relay |
| 全 env / config キーを一覧で確認したい | [config-reference.md](config-reference.md) | (全キー正本テーブル) |

## 最短起動 (dev)

[LUDIARS Infra](https://github.com/LUDIARS/Infra) の PostgreSQL / Redis / MailHog が起動済みで、Infisical 認証情報 (`.env.secrets`) が用意されている前提:

```bash
npm install
npm run env:setup        # 初回のみ: Infisical 認証情報を対話設定 (.env.secrets 生成)
npm run env:initialize   # 初回のみ: env-cli.config.ts の既定値を Infisical に登録
npm run env:up           # .env 一時生成 → docker compose up (dev) → 終了後 .env 削除
```

Infisical を使わずローカル直起動する場合は [server-bootstrap.md](server-bootstrap.md) の「Docker なし直接起動」を参照。

## 設定の優先順位

環境変数の解決順 (上が優先):

1. **プロセス env に既に存在する値** — Docker Compose の `environment:` / host shell の `export` / Excubitor inject 等。`server/src/lib/env-bootstrap.ts` の `ensureEnv()` は既存値を上書きしない。
2. **Infisical から fetch した値** — 必須キーが env に欠けている場合のみ `INFISICAL_*` 認証で取得して注入 (`env-bootstrap.ts`)。`npm run env:gen` / `env:up` も Infisical → `.env` の経路。
3. **`server/src/config.ts` の `env(key, fallback)` フォールバック** — dev 向けの既定値。`required.production` (= `JWT_SECRET` / `DATABASE_URL` / `REDIS_URL`) は production で欠けると起動を中止する (`env-cli.config.ts`)。

> `.env.example` は**参考用テンプレート**であり、実際の `.env` は env-cli が Infisical から再生成する (手動編集は上書きされる)。`.env` / `.env.secrets` は `.gitignore` 済み。

## 関連設計ドキュメント

| ドキュメント | 範囲 |
|---|---|
| [../README.md](../README.md) | spec 全体の目次・認証経路の選び方・トークン署名一覧・Redis キー命名 |
| [../auth-flows.md](../auth-flows.md) | 認証経路 5 種 (user / project / tool / composite / oauth) |
| [../peer-relay.md](../peer-relay.md) | サービス間直接 WS 通信 (`relay_pairs` + `verify_token`) |
| [../project-management.md](../project-management.md) | `managed_projects` テーブル・YAML 定義・動的テーブル |
| [../identity-verification.md](../identity-verification.md) | デバイス本人確認 (composite フロー) |
| [../../docs/integration_guide.md](../../docs/integration_guide.md) | 別プロジェクト側に認証を組み込む実装ガイド |
| [../../README.md](../../README.md) | リポジトリ概要・起動コマンド表・WS プロトコル |
