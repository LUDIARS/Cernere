# Cernere パッケージの使用方法

## セットアップ

### 1. `.npmrc` を作成

プロジェクトルートに `.npmrc` を作成し、`@ludiars` スコープの registry を指定:

```
@ludiars:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

### 2. GitHub Personal Access Token を設定

GitHub の Settings → Developer settings → Personal access tokens で、`read:packages` 権限を持つトークンを生成し、環境変数 `GITHUB_TOKEN` に設定:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

### 3. インストール

```bash
npm install @ludiars/cernere-id-cache
npm install @ludiars/cernere-id-service
npm install @ludiars/cernere-service-adapter
npm install @ludiars/cernere-env-cli
```

## パッケージ一覧

| パッケージ | 説明 |
|-----------|------|
| `@ludiars/cernere-id-cache` | JWT 検証 + ユーザー情報キャッシュ (Hono ミドルウェア) |
| `@ludiars/cernere-id-service` | 汎用 Identity Service SDK (認証ルート, セッション, プラグイン) |
| `@ludiars/cernere-service-adapter` | サービス間 WebSocket 接続アダプタ (3点方式認証) |
| `@ludiars/cernere-env-cli` | Infisical シークレット管理 CLI |

## バージョニング

- `packages/*/package.json` の `version` を更新して main にマージ
- CI が自動で GitHub Packages にパブリッシュ
- バージョンが既に存在する場合はスキップ
