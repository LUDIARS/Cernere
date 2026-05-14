# REVIEW_QUALITY — 2026-05-13

評価: **B**

## ドキュメント

- `README.md` / `CLAUDE.md` / `spec/security_design.md` の 3 ドキュメントが一貫しており、 4 層防御 / 常時接続セッションの設計思想が読み取りやすい。 評価 **A** 級。
- `spec/` 配下に `auth-flows.md` / `identity-verification.md` / `oauth-token-storage.md` / `peer-relay.md` 等の機能別 spec が揃う。 ただし `commit-plan.md` のような **実装計画スナップショット** が混在しており、 spec ディレクトリの「永続的仕様」と「TODO スナップショット」を分けると良い。

## コードスタイル

- TypeScript の型は概ね丁寧。 `WsUserData` / `ProjectWsUserData` / `CompositeWsUserData` を **uWS UserData ごとに分離** している点はクリーン。
- ただし `c.set("userId" as never, user.id as never)` のような `as never` 多用 (`packages/id-cache/src/middleware.ts:45-65`) は Hono の `ContextVariableMap` を `module.d.ts` で正しく拡張すれば不要。 可読性低下。

## エラーハンドリング

- `AppError` (`server/src/error.ts`) で status code を統一する設計は良い。
- ただし `auth-handler.ts` は **`throw new Error("Unauthorized: ...")`** を多用しており、 `classifyError` (`app.ts:89-113`) が **文字列マッチで status を割り当てる** 構造になっている。 `AppError.unauthorized(...)` で型で表現したほうが堅牢 (タイポ 1 文字で 500 に化ける)。

## ログ

- `devLog` / `devError` (`server/src/logging/dev-logger.ts`) と `authLogger` (`server/src/logging/auth-logger.ts`) で構造化済みで、 production / development の境界が明確。
- 一方で **`handler.ts` 内に直接 `console.log` が散在** (`server/src/ws/handler.ts:34-55, 167-184`)。 構造化ロガーへ寄せたい。

## テスト

- `git ls-files | head -80` 範囲では `packages/service-adapter/tests/peer-adapter.test.ts` のみ確認できた。 server 本体に **テストが見当たらない** (要再確認)。
- `auth-handler.ts` の認証分岐、 `commands.ts` の Layer 2-3 ガード、 `identity-verification.ts` の anomaly 検知は **テスト保護が必須レベル** だが、 unit/integration ともコードベース内に見当たらないのは大きなリスク。

## 依存・ビルド

- pnpm-workspace.yaml / .npmrc / package.json の build script は最近の commit (`#80-#88`) で繰り返し修正されており、 まだ落ち着いていない。 CI (`.github/workflows/compile-check.yml`) で固定。
- `bash.exe.stackdump` / `grep.exe.stackdump` がリポ直下にあるが `.gitignore` 漏れ。 (`git ls-files` には出ていないので tracked ではないが、 開発者環境のお片付け対象)

## 命名

- 全体に説明的で読みやすい。 ただし `id-service` / `id-cache` / `service-adapter` という 3 つの自前パッケージの責務境界が初見でわかりにくい (`docs/composite_design.md` 等を読まないと `id-cache` が単なる cache なのか auth middleware なのか掴めない)。 README に責務マトリクスがあると良い。

## まとめ

ドキュメント A、 型・命名 B、 テスト C (ほぼ無し) で総合 **B**。 テスト整備が最優先課題。
