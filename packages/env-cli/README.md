# @ludiars/env-cli

Infisical からシークレットを取得し、Docker 用 `.env` を自動生成する CLI ツール。

## 概要

```
┌──────────────────────────────────────────────────────────┐
│  env-cli setup   → Infisical 認証設定 (.env.secrets)     │
│  env-cli env     → Infisical → .env 生成                 │
│  docker compose up → .env を読んで起動                    │
│  サービス内 → SecretManager がランタイムで残りを取得       │
└──────────────────────────────────────────────────────────┘
```

設定は2層に分離されます:

| 層 | 管理方法 | 例 |
|---|---|---|
| **インフラ設定** | `.env` に出力 → Docker が使用 | ポート, DB接続先, Redis URL |
| **シークレット** | サービスがランタイムで Infisical API 取得 | JWT_SECRET, OAuth 認証情報 |

## インストール

```bash
npm install -D @ludiars/env-cli
```

## セットアップ

### 1. 設定ファイルを作成

プロジェクトルートに `env-cli.config.ts` (または `.js` / `.json`) を作成:

```ts
import type { EnvCliConfig } from "@ludiars/env-cli";

export default {
  name: "MyProject",
  infraKeys: {
    APP_PORT: "3000",
    DB_PORT: "5432",
    DB_HOST: "db",
    DB_USER: "myapp",
    DB_PASSWORD: "myapp",
    DB_NAME: "myapp",
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

### 3. .env を生成

```bash
npx env-cli env
```

Infisical から全シークレットを取得し、`.env` を生成します:

- `infraKeys` にあるキー → `.env` に値を出力 (Infisical に登録があればそちら優先)
- Infisical bootstrap 認証情報 → `.env` に出力 (サービスが SecretManager で使用)
- その他のキー → コメントとして記載 (サービスがランタイムで取得)

### 4. Docker 起動

```bash
docker compose up -d
```

## CLI リファレンス

| コマンド | 説明 |
|---|---|
| `env-cli setup` | 対話形式で Infisical 認証を設定 |
| `env-cli env` | Infisical → `.env` を生成 |
| `env-cli env --stdout` | `.env` 内容を標準出力 (パイプ用) |
| `env-cli test` | Infisical 接続テスト |
| `env-cli get <KEY>` | 指定キーの値を取得 (パイプ用) |
| `env-cli list` | シークレット一覧 (値はマスク表示) |
| `env-cli set <KEY> <VALUE>` | シークレットを作成/更新 |

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
} from "@ludiars/env-cli";

const bootstrap = loadBootstrap(".env.secrets");
if (bootstrap) {
  const token = await authenticate(bootstrap);
  const secrets = await fetchSecrets(bootstrap, token);
  console.log(`取得: ${secrets.length} 件`);
}
```

### エクスポート一覧

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
.env               ← Docker 用環境変数 (env-cli env で生成, gitignore)
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
