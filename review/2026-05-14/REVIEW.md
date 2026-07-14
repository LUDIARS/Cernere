# AI Code Review Format: Cernere

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | main |
| レビュー実施日 | 2026-05-14 |
| weighted_score | **B** (Critical: 2 / High: 4) |

## 概要

PASETO v4 (Ed25519) project token + displayName + aud claim 実装 (Issue #91 Phase 1)。 HS256 legacy fallback あり。 audience validation + key rotation ceremony が要対応。

---

## 総合評価 (Overall Assessment)

| # | レビュー観点 | 評価 | ドキュメント |
|---|------------|------|------------|
| 1 | 脆弱性 | B | [REVIEW_VULNERABILITY.md](REVIEW_VULNERABILITY.md) |
| 2 | 設計強度 | B | [REVIEW_DESIGN.md](REVIEW_DESIGN.md) |
| 3 | 設計思想の一貫性 | B | [REVIEW_DESIGN.md](REVIEW_DESIGN.md) |
| 4 | モジュール分割度 | A | [REVIEW_DESIGN.md](REVIEW_DESIGN.md) |
| 5 | コード品質 | B | [REVIEW_IMPLEMENTATION.md](REVIEW_IMPLEMENTATION.md) |
| 6 | データスキーマ | A | [REVIEW_IMPLEMENTATION.md](REVIEW_IMPLEMENTATION.md) |
| 7 | 機能改善 | - | [REVIEW_MISSING_FEATURES.md](REVIEW_MISSING_FEATURES.md) |
| 8 | 不足機能 | - | [REVIEW_MISSING_FEATURES.md](REVIEW_MISSING_FEATURES.md) |
| 9 | SRE | B | [REVIEW_IMPLEMENTATION.md](REVIEW_IMPLEMENTATION.md) |
| 10 | ゼロトラスト | B | [REVIEW_VULNERABILITY.md](REVIEW_VULNERABILITY.md) |
| 11 | セキュリティ | B | [REVIEW_VULNERABILITY.md](REVIEW_VULNERABILITY.md) |
| 12 | テスト戦略・カバレッジ | C | [REVIEW_QUALITY.md](REVIEW_QUALITY.md) |
| 13 | パフォーマンス・ベンチマーク | B | [REVIEW_QUALITY.md](REVIEW_QUALITY.md) |
| 14 | ライセンス遵守 | A | [REVIEW_QUALITY.md](REVIEW_QUALITY.md) |
| 15 | クロスプラットフォーム互換 | A | [REVIEW_QUALITY.md](REVIEW_QUALITY.md) |
| 16 | ドキュメント完備性 | B | [REVIEW_QUALITY.md](REVIEW_QUALITY.md) |

**評価基準:**
- **A**: 問題なし。 ベストプラクティスに準拠
- **B**: 軽微な改善点あり。 運用上の影響は低い
- **C**: 改善が必要。 リリース前の対応を推奨
- **D**: 重大な問題あり。 即時対応が必要

## 重大指摘サマリ

- Critical: **2**
- High: **4**
- 自動修正適用: 0 件 ([AUTOFIX.md](AUTOFIX.md))

詳細は各 REVIEW_*.md を参照。
