# Cernere を AWS 拠点へ移す (Cernere 側の実装)

- Actio: `actio:c1083c0a-dc02-45b1-a520-6b773579dafb`
- 設計: [../plan/2026-10-11-aws-site-migration.md](../plan/2026-10-11-aws-site-migration.md)
- 手順書: [../setup/site-data-transfer.md](../setup/site-data-transfer.md)、[../setup/server-bootstrap.md](../setup/server-bootstrap.md)

## 分解

| # | 内容 | 主な変更 |
|---|---|---|
| 1 | data-export / data-import を実装し、bootstrap manifest を差し替える | `scripts/site/{export,import}-data.mjs`、`server/scripts/site-data/*`、`excubitor.bootstrap.json` |
| 2 | backend の catalog port を 8080 → 8086 にする (LISTEN_PORT・health・provides・frontend の VITE_BACKEND_URL) | `excubitor.catalog.yaml` |
| 3 | frontend を setup でビルドし `vite preview` で配る (preview proxy で backend へ) | `scripts/site/setup.mjs`、`scripts/site/build-frontend.mjs`、`frontend/vite.config.ts`、catalog |
| 4 | 手順書を更新する | `spec/setup/*` |

## 判断

- export / import の本体は server の TypeScript に置いた。Vault からの `DATABASE_URL` 取得 (`ensureScriptEnv`)・`postgres` client・
  log-weaver 契約を再利用でき、新しい npm 依存が要らない。入口の `.mjs` は server の `tsx` を `--import` ローダにして同じ Node で実行する。
- SQL (行数・rename・create・drop) はホストから `DATABASE_URL` で直接行い、拠点差のある pg_dump / pg_restore だけ host / docker exec を設定で選ぶ。
- server の `LISTEN_PORT` 既定値 (8080) と docker compose は変えない。catalog が env で 8086 を注入する。
- `cernere-frontend` は catalog の command を preview に切り替えた。dev 用 script と `cernere-frontend-test` は dev server のまま。
- migration は追加しない。

## 検証

- `LOG_WEAVER=1 npx vitest run tests/site-data`: 4 files / 39 tests 通過。
- `npx vitest run` (server 全体): 105 files / 851 tests 通過。
- `node scripts/site/build-frontend.mjs`: `npm ci` と `tsc -b && vite build` が通過。
- 入口の異常系 (`--output` 相対パス、`--sha256` 不正) が DB に触れず非 0 で止まることを確認。
- 実データの export / import、サービスの起動、Vault・CF・topology の変更は行っていない (運用作業)。
