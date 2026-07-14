# AI Code Review — Cernere (LUDIARS 認証 / ID 基盤)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ | main (1 commit since 2026-05-19) |
| レビュー実施日 | 2026-05-29 |
| 対象コミット範囲 | 46c4b11 (2026-05-19)..5ecac4d (2026-05-23) |
| 前回レビュー | 2026-05-19 (評価: A) |

## 総合評価（全 16 項目）

| # | レビュー観点 | 評価 | 重大指摘数 | ドキュメント |
|---|------------|------|-----------|------------|
| 1 | 脆弱性 | A | 0 | REVIEW_VULNERABILITY.md |
| 2 | 設計強度 | A | 0 | REVIEW_DESIGN.md |
| 3 | 設計思想の一貫性 | A | 0 | REVIEW_DESIGN.md |
| 4 | モジュール分割度 | A | 0 | REVIEW_DESIGN.md |
| 5 | コード品質 | A | 0 | REVIEW_IMPLEMENTATION.md |
| 6 | データスキーマ | A | 0 | REVIEW_IMPLEMENTATION.md |
| 7 | 機能改善 | A | — | REVIEW_MISSING_FEATURES.md |
| 8 | 不足機能 | B | — | REVIEW_MISSING_FEATURES.md |
| 9 | SRE | A | 0 | REVIEW_IMPLEMENTATION.md |
| 10 | ゼロトラスト | A | 0 | REVIEW_VULNERABILITY.md |
| 11 | セキュリティ | A | 0 | REVIEW_VULNERABILITY.md |
| 12 | テスト戦略・カバレッジ | D | 1 | REVIEW_QUALITY.md |
| 13 | パフォーマンス・ベンチマーク | A | 0 | (本変更非該当) |
| 14 | ライセンス遵守 | A | 0 | REVIEW_QUALITY.md |
| 15 | クロスプラットフォーム互換 | A | 0 | REVIEW_QUALITY.md |
| 16 | ドキュメント完備性 | A | 0 | REVIEW_QUALITY.md |

**重み付けスコア: A** (前回同等。コミット 1 件、派生フィールド追加のみで設計・セキュリティ影響なし)

---

## 総合サマリ

**feat(project): managed_project.list / overview に frontendUrl を露出 (#103)**

- 対象: `server/src/project/service.ts` の `listProjects()` / `listUserProjectsOverview()` / インターフェース
- 変更量: +37 行 (ヘルパー関数追加、フィールド同梱)
- 目的: Memoria Hub Shell が `.well-known/ludiars-app.json` manifest probe するため、 `schema_definition.endpoint.frontend_url` をクライアント戻り値に同梱
- DB スキーマ: 変更なし (既存フィールドの再利用)
- セキュリティ影響: なし (read-only フィールド、 権限チェック不変)

### 良い点

- **責務の分離**: `extractFrontendUrl()` ヘルパー関数で重複排除、 再利用性が良い
- **null-safe 実装**: `endpoint?.frontend_url` のオプショナルチェーンと `typeof` ガード両立
- **ドキュメント明記**: WS コマンド仕様 (project-management.md) と接続レジストリ仕様 (project-connection-registry.md) に同梱背景を記載
- **デストラクチャリング戻り**: `{ schemaDefinition, ...rest }` で内部値を除外し、 公開インターフェース設計が明確

### 主な指摘

| 重大度 | 該当箇所 | 内容 |
|--------|----------|------|
| High (新規) | `server/src/project/schema.ts` | endpoint.frontend_url の URL format validation (z.url()) 未実装。 malformed URL で boot 後に Hub Shell probe 失敗が silent |
| High (継続) | `server/tests/` 全体 | unit/integration/E2E テスト基盤未整備 (新規 extractFrontendUrl / list / overview ロジックの assert 不可) |
| Medium (新規) | spec/project-management.md | Memoria Hub Shell probe 仕様 (retry/backoff/fallback) が Cernere 側に未記載 |

### Critical 0、 High 2、 Medium 1、 既存 D 評価 (テスト) は継続

---

## 評価基準

- **A**: 問題なし。ベストプラクティスに準拠
- **B**: 軽微な改善点あり。運用上の影響は低い
- **C**: 改善が必要。リリース前の対応を推奨
- **D**: 重大な問題あり。即時対応が必要
