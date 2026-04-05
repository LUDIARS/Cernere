# @cernere/env-cli

Infisical からシークレットを取得し、Docker 用 `.env` を一時生成して安全に起動する CLI ツール。

## 概要

```
┌──────────────────────────────────────────────────────────┐
│  env-cli setup      → Infisical 認証設定 (.env.secrets)  │
│  env-cli initialize → config のデフォルト値を Infisical に│
│  env-cli up         → .env 一時生成 → docker compose up  │
│                        → 起動後 .env 自動削除             │
└──────────────────────────────────────────────────────────┘
```

設定は 2 層に分離されます:

| 層 | 管理方法 | 例 |
|---|---|---|
| **インフラ設定** | `.env` に一時出力 → Docker が使用 | ポート, DB 接続���, Redis URL |
| **シークレット** | サービスがランタイムで Infisical API 取得 | JWT_SECRET, OAuth 認証情報 |

> `.env` はディスク上に残りません。`env-cli up` は起動後に自動削除します。

## セットアップ

### 1. 設定ファイルを作成

プロジェクトルートに `env-cli.config.ts` (または `.js` / `.json`) を作��:

```ts
import type { EnvCliConfig } from "@cernere/env-cli";

export default {
  name: "MyProject",
  infraKeys: {
    APP_PORT: "3000",
    DB_PORT: "5432",
    DATABASE_URL: "postgresql://myapp:myapp@db:5432/myapp",
    REDIS_URL: "redis://redis:6379",
  },
} satisfies EnvCliConfig;
```

### 2. Infisical を設定

```bash
npx env-cli setup
```

対話形式で以下を入力:

- **Site URL** — Infisical インスタンスの URL (デフォルト: `https://app.infisical.com`)
- **Project ID** — Infisical ダッシュボードの Settings → General
- **Environment** — `dev` / `staging` / `prod`
- **Client ID** — Universal Auth の Machine Identity
- **Client Secret** — 同上

認証情報は `.env.secrets` に保存されます (`.gitignore` に追加してください)。

### 3. デフォルト値を Infisical に登録

```bash
npx env-cli initialize
```

`env-cli.config.ts` の `infraKeys` に定義されたデフォルト値を Infisical に登���します。既に存在するキーはスキップされるため、安全に何���でも実行可能です。

### 4. 開発環境の起動

```bash
npx env-cli up
```

以下を自動で実行します:

1. Infisical からシークレットを取得し `.env` を一時生成
2. OS を判定し適切な docker-compose ファイルを選択 (Windows / Linux)
3. `docker compose --profile dev up` を実行 (DB + Backend + Frontend)
4. `.env` を自動削除

引数を渡すことも可能:

```bash
npx env-cli up -- --build              # リビルド付き起動
npx env-cli up -- -d postgres redis    # DB のみバックグラウンド起動
```

## CLI リファレンス

| コマンド | 説明 |
|---|---|
| `env-cli setup` | 対話形式で Infisical 認証を設定 |
| `env-cli initialize` | config の infraKeys を Infisical に登録 (未存在のみ) |
| `env-cli test` | Infisical 接続テスト |
| `env-cli list` | シークレット一覧 (値はマスク表示) |
| `env-cli get <KEY>` | 指定キーの値を取得 (パイプ用) |
| `env-cli set <KEY> <VALUE>` | シークレットを作成/更新 |
| `env-cli env` | Infisical → `.env` を生成 |
| `env-cli env --stdout` | `.env` 内容を標準出力 (パイプ用) |
| `env-cli up [-- ...]` | `.env` 一時生成 → `docker compose up` → `.env` 自動削除 |

## 設定オプション (`EnvCliConfig`)

```ts
interface EnvCliConfig {
  /** プロジェクト名 (CLI ヘッダーに表示) */
  name: string;

  /** Docker 用 .env に出力するインフラキーとデフォルト値 */
  infraKeys: Record<string, string>;

  /** .env.secrets の保存先 (デフォルト: cwd/.env.secrets) */
  secretsPath?: string;

  /** .env の出力先 (デフォルト: cwd/.env) */
  dotenvPath?: string;

  /** Infisical デフォルト Site URL */
  defaultSiteUrl?: string;

  /** Infisical デフォルト Environment */
  defaultEnvironment?: string;
}
```

## Programmatic API

CLI 以外からも利用可能:

```ts
import {
  authenticate,
  fetchSecrets,
  buildDotenv,
  loadBootstrap,
} from "@cernere/env-cli";

const bootstrap = loadBootstrap(".env.secrets");
if (bootstrap) {
  const token = await authenticate(bootstrap);
  const secrets = await fetchSecrets(bootstrap, token);
  console.log(`取得: ${secrets.length} 件`);
}
```

### エクスポ���ト一覧

| モジュール | 関数 / 型 |
|---|---|
| **Infisical** | `authenticate`, `fetchSecrets`, `getSecretByKey`, `upsertSecret` |
| **Env File** | `parseEnvFile`, `loadBootstrap`, `saveBootstrap` |
| **Generator** | `buildDotenv`, `EnvGeneratorResult` |
| **Prompt** | `createPrompt`, `Prompt` |
| **Types** | `EnvCliConfig`, `InfisicalBootstrap`, `RawSecret` |

## ファイル構成

```
.env.secrets       ← Infisical 認証情報 (gitignore)
.env               ← Docker 用環���変数 (env-cli up で一時��成・自動削除)
env-cli.config.ts  ← プロジェクト固有設定 (git 管理)
```

## .gitignore に追加

```gitignore
.env
.env.secrets
```

## 前提条件

- Node.js >= 20
- Infisical アカウント + Universal Auth (Machine Identity)

## ライセンス

MIT
