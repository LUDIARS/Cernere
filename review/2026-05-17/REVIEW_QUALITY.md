# 品質保証レビュー — Cernere (Web Service)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| レビュー実施日 | 2026-05-17 |

## 1. テスト戦略・カバレッジ: **B**

| 評価 | 観点 | 所見 |
|------|------|------|
| B | unit テスト | server/src に test ファイルなし。packages/service-adapter/tests/peer-adapter.test.ts のみ |
| B | integration テスト | DB / Redis session / OAuth callback の e2e flow test 欠落 |
| C | E2E テスト | WS upgrade → ping/pong → module_request → operation_logs の全フロー未検証 |
| A | エッジケース | password length / token TTL / session TTL の制約 code に明示 |
| A | CI 自動実行 | compile-check.yml で TypeScript type check (test 未統合) |

## 2. ライセンス遵守: **A**

| 依存 | ライセンス | 帰属表示 |
|-----|----------|---------|
| paseto | MIT | OK |
| jsonwebtoken | MIT | OK |
| bcryptjs | MIT | OK |
| uWebSockets.js | Apache-2.0 (or custom SSPL) | 要確認 |
| Drizzle ORM | Apache-2.0 | OK |

- [x] LICENSE (MIT) プロジェクトルート
- [x] 依存 GPL/copyleft なし
- [x] NOTICE: docker image に同梱不要と判断
- [ ] AI 生成コード: README に明示推奨

## 3. ドキュメント完備性: **A**

| 評価 | 観点 | 所見 |
|------|------|------|
| A | README | 概要 / セキュリティ思想 / 技術スタック / 起動方法 |
| A | DESIGN | spec/security_design.md で脅威モデル + docs/relay_design.md |
| A | API リファレンス | docs/service_interface.md で WS protocol 完全 |
| A | inline コメント | paseto.ts / jwt.ts / commands.ts で /** */ 形式 |
| B | CONTRIBUTING / ランブック | Contributing.md なし。運用ランブック (Redis/DB 障害手順) なし |

## 総合評価

| # | 観点 | 評価 |
|---|------|------|
| 1 | テスト | B |
| 2 | ライセンス | A |
| 3 | ドキュメント | A |
