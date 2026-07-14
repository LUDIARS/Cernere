# 実装評価 — Cernere (Web Service)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| レビュー実施日 | 2026-05-17 |

## 1. コード品質

| 該当箇所 | 問題分類 | 説明 |
|----------|---------|------|
| auth-handler.ts:44-51 | switch 文の複数分岐 | login action で 3 分岐 (tool/project/user)。責務明確で問題なし |
| packages/id-cache/cache.ts:67-84 | LRU eviction | Map を FIFO 削除 (古いもの 20%)。性能上問題なし |
| commands.ts:63-77 | operation_logs 書き込み | finally 節で DB insert、console.error 出力。alert example docs 追記推奨 |
| ws/handler.ts | ping/pong timeout | app.ts idleTimeout=120 で自動切断 (framework guarantee) |

### コード品質チェック

- [x] マジックナンバー: PROJECT_TOKEN_TTL_SEC / SESSION_TTL_SECS 定数化
- [x] 過度なネスト: 最大 2-3 層
- [x] デッドコード: なし (TS strict)
- [x] 例外処理: try-catch で JSON.parse wrap
- [x] 命名: 動詞-目的語形式で統一
- [x] 関数長: 最長 ~200 行 (projectUserToken)

## 2. SRE / 運用信頼性

| 評価 | 観点 | 所見 |
|------|------|------|
| B | 監視・アラート | operation_logs DB 記録。console.error 出力するが log 集約・メトリクス名定義なし |
| A | 障害復旧・冪等性 | register で email check + insert、refresh token rotation は atomic |
| A | 設定・secrets 管理 | CERNERE_* env vars Infisical 通合 |
| C | ドキュメント / ランブック | spec/security_design.md, docs/relay_design.md, docs/service_interface.md あり。運用 troubleshooting なし |
| B | 自動化 / CI 統合 | compile-check.yml で TypeScript type check のみ。lint/test なし |

## 3. データスキーマ・設定構造

| スキーマ | 評価 |
|---------|------|
| users / refresh_sessions / managed_projects / operation_logs / organizations (21 table) | refresh_sessions.expiresAt TTL 完全 |
| Redis keys: session/ustate/ratelimit/authcode | TTL 明確 (session 7日、ratelimit 10分) |
| env vars: CERNERE_PASETO_*, JWT_SECRET, DATABASE_URL, REDIS_URL | prefix 統一、Infisical 統合 |

## 総合評価

| # | 観点 | 評価 |
|---|------|------|
| 1 | コード品質 | A |
| 2 | SRE / 運用信頼性 | B |
