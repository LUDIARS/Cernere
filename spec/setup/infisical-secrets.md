# 秘密情報を Infisical で管理するための設定

Cernere の秘密 (`JWT_SECRET` / OAuth secret / PASETO 鍵 / DB URL 等) を `.env` に平文で持たず、Infisical で集中管理して起動時に注入する設定を扱う。CLI 実装は `packages/env-cli/`、起動時注入は `server/src/lib/env-bootstrap.ts`。

## 目的

- `.env` を git に残さない / 手書きしない。`.env` は env-cli が Infisical から**毎回再生成**する一時ファイル (手動編集は次回上書き)。
- 起動時に必須キーが欠けていたら Infisical universal-auth で fetch して `process.env` に注入する。

## 2 つの注入経路

| 経路 | いつ使う | 仕組み |
|---|---|---|
| **CLI 生成** (`npm run env:gen` / `env:up`) | docker compose 起動・ローカル起動の前段 | Infisical → `.env` を生成 (`env:up` は up 後に削除) |
| **起動時 fetch** (`ensureEnv()`) | コンテナ / プロセスを直接立てたとき | 必須キーが env に無ければ `INFISICAL_*` で login → secrets/raw を取得して注入 |

`ensureEnv()` は**既に env に存在する値を上書きしない**。Docker Compose の `environment:` や host shell で渡した値が最優先 ([README.md](README.md) の設定優先順位)。

## 設定ファイルとキー

### `.env.secrets` — Infisical 認証情報 (gitignore 済み)

`npm run env:setup` が対話形式で生成する。中身は Infisical universal-auth の資格情報:

| キー | 用途 |
|---|---|
| `INFISICAL_SITE_URL` | Infisical のベース URL (例: 自前ホスト) |
| `INFISICAL_PROJECT_ID` | workspace (project) ID |
| `INFISICAL_ENVIRONMENT` | 取得する環境 (既定 `dev`) |
| `INFISICAL_CLIENT_ID` | universal-auth の client id |
| `INFISICAL_CLIENT_SECRET` | universal-auth の client secret |

> これらは `ensureEnv()` でも参照される (`server/src/lib/env-bootstrap.ts`)。CLI 経由なら `.env.secrets`、コンテナ直起動なら host shell / compose の `environment:` で同じ 5 キーを渡す (`docker-compose.yaml` が `${INFISICAL_*:-}` で透過)。

### `env-cli.config.ts` — どのキーを Infisical に置くか

`infraKeys` に「Infisical に同名キーがあればそれを、無ければ既定値を使う」キー群が宣言されている (DB/Redis/JWT/OAuth/AWS/Mail 等)。`required.production` (`JWT_SECRET` / `DATABASE_URL` / `REDIS_URL`) は production で placeholder のままだと `.env` 生成を中止する。

## 手順

```bash
npm install
npm run env:setup        # Infisical 認証情報を対話入力 → .env.secrets 生成
npm run env:test         # 接続テスト
npm run env:initialize   # env-cli.config.ts の infraKeys 既定値を Infisical に登録 (未存在のみ)
npm run env:gen          # Infisical → .env を生成 (確認用、--stdout で標準出力)
npm run env:up           # .env 一時生成 → docker compose up → .env 削除
```

個別操作:

```bash
npm run env:list                 # 登録済みキー一覧
npm run env:get JWT_SECRET       # 値を取得
npm run env:set JWT_SECRET <値>  # 作成 / 更新
```

`infraKeys` に**載っていない**秘密 (例: `CERNERE_PASETO_SECRET_KEY` / OAuth 本番 secret) は `env:set` で Infisical に直接登録する。サービス起動時は `ensureEnv()` が必須キー fetch のついでに同じ workspace の全 secret を注入するため、`infraKeys` 外でも Infisical に置けば反映される。

## 注意点

- **`service secret は per-user / memory-only`**: 共有された long-lived な service_credential を Infisical に置いて配り回すのは設計上 NG。サービスが「ログイン中ユーザ × project」のトークンを欲しい場合は `/api/auth/project-token` で都度発行する ([service-registration.md](service-registration.md))。Infisical に置くのは Cernere 自身が使う秘密 (署名鍵・OAuth secret 等) に限る。
- **PASETO 秘密鍵は Hub に置かない**: `CERNERE_PASETO_SECRET_KEY` は Cernere の secret store (Infisical) のみ。サービス側は `/.well-known/cernere-public-key` で公開鍵だけ取得する ([paseto-keys.md](paseto-keys.md))。
- `.env` / `.env.secrets` は `.gitignore` 済み。コミットしないこと。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `Infisical login failed: <status>` | `INFISICAL_*` の client_id / secret / site_url 誤り。`npm run env:test` で確認。 |
| `still missing after Infisical fetch: ...` | 必須キーが Infisical 未登録。`env:initialize` → `env:set` で補う。 |
| `.env` を編集したのに反映されない | `env:gen` / `env:up` が Infisical から上書き生成するため。値は Infisical 側 (`env:set`) で変える。 |
| 本番で `.env` 生成が中止される | `required.production` のキーが placeholder のまま。Infisical の prod 環境に実値を登録する。 |
