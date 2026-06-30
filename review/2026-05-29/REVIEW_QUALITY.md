# 品質保証レビュー — Cernere

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ | main |
| レビュー実施日 | 2026-05-29 |
| 対象コミット範囲 | 46c4b11..5ecac4d |

---

## 1. テスト戦略・カバレッジ (Test Strategy & Coverage)

| 評価 | 観点 | 所見 |
|------|------|------|
| D | unit テストの網羅性 | server/src 全体で unit test ファイルなし。 extractFrontendUrl(), listProjects(), listUserProjectsOverview() のテストコード未実装 |
| D | integration テストの網羅性 | packages/service-adapter/tests/ に peer-adapter.test.ts のみ。 project service のテスト (DB query + schema validation + list/overview メソッド) 未実装 |
| D | E2E テストの存在 | project.list / project.overview コマンドの通端 E2E テスト (WebSocket 接続 → auth → command dispatch → response validate) 未実装 |
| D | エッジケース・境界値テスト | endpoint.frontend_url が empty string / invalid URL の場合の behavior test なし |
| D | CI でのテスト自動実行 | .github/workflows に compile-check.yml / publish-packages.yml のみ。 jest / vitest run なし |

**評価: D** — テスト基盤ゼロ。 本番機能だが検証メカニズム未整備

---

## 2. ライセンス遵守・OSS 帰属表示 (License Compliance)

| 該当依存 | ライセンス | 配布形態 | 互換性評価 | 帰属表示状態 |
|---------|----------|---------|-----------|-------------|
| (リポ自体) | MIT | npm package + Docker | OK | LICENSE ファイル存在 |
| uWebSockets.js | Apache 2.0 | npm (node_modules) | OK | NOTICE / THIRD_PARTY 未確認 |
| drizzle-orm | Apache 2.0 | npm | OK | — |
| ioredis | MIT | npm | OK | — |
| bcryptjs | MIT | npm | OK | — |
| jsonwebtoken | MIT | npm | OK | — |
| zod | MIT | npm | OK | — |

### チェック結果

- [x] プロジェクトライセンス: LICENSE (MIT) + README.md に明記
- [x] 依存 copyleft: Apache 2.0 (uWebSockets, drizzle) は permissive。 GPL 混在なし
- [x] NOTICE 有無: 推奨だが、 MIT 単体では法律上必須ではない
- [x] DCO: PR 作成時に Co-Authored-By 付与あり。 GitHub Actions による自動 check は未設定 (推奨)

**評価: A** — 基本的に OK だがドキュメント整備推奨

---

## 3. ドキュメント完備性 (Documentation Completeness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | README の網羅性 | README.md に 100 行以上。 概要 / セキュリティ思想 / 技術スタック / プロジェクト構成 / セットアップ / 起動方法を記載 |
| A | DESIGN / アーキテクチャ図 | spec/ に security_design.md / project-management.md / relay_design.md / ws-protocol.md / auth-flows.md 等 13 本の MD。 mermaid sequence diagram 複数 |
| A | API / インターフェースリファレンス | spec/project-management.md に WS コマンド表、 project-connection-registry.md にレジストリ仕様。 新規 frontendUrl は両者に記載済 |
| B | inline コメントの粒度 | extractFrontendUrl に JSDoc コメント明記。 ただし service.ts 全体で一部 helper のコメントが薄い |
| A | 開発者向け CONTRIBUTING / ランブック | CLAUDE.md に "RULE" section で基盤設計ルール網羅。 troubleshooting section は未実装 |

**評価: A** — spec/ が充実。 ただし端末開発 (npm scripts / devDeps) の明記推奨

---

## 4. クロスプラットフォーム互換 (Cross-Platform Compatibility)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | OS 依存 | Node.js + Docker base のため OS 依存最小 |
| A | パス区切り | path.join() で normalize 済み |
| A | エンコーディング | UTF-8 統一。 PASETO / JWT は base64url |

**評価: A** — クロスプラットフォーム互換性問題なし

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | テスト戦略・カバレッジ | D | 1 |
| 2 | ライセンス遵守 | A | 0 |
| 3 | ドキュメント完備性 | A | 0 |
| 4 | クロスプラットフォーム互換 | A | 0 |

**品質所見**: ドキュメント・スペック記載は excellent だが、 テスト基盤 (unit / integration / E2E) が未実装で本番対応リスク高い。 特に新規フィールド (frontendUrl) のバリデーション・エッジケースの検証が必須。
