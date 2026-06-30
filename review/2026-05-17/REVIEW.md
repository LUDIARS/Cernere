# Cernere レビュー (Web Service)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Cernere |
| 対象ブランチ / PR | main |
| レビュー実施日 | 2026-05-17 |
| 対象コミット範囲 | b4f2b37 (直近 9 commits、2026-05-14 以降) |

## 総合評価マトリクス

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 設計強度 | A | 0 |
| 2 | 設計思想の一貫性 | A | 0 |
| 3 | モジュール分割度 | A | 0 |
| 4 | コードレベル脆弱性 | A | 0 |
| 5 | テスト戦略・カバレッジ | B | 1 |
| 6 | ライセンス遵守 | A | 0 |
| 7 | ドキュメント完備性 | A | 0 |
| 8 | SRE / 運用信頼性 | B | 1 |
| 9 | 入力バリデーション | A | 0 |
| 10 | エラーハンドリング | A | 0 |
| 11 | 状態管理の明確性 | A | 0 |
| 12 | 認証・認可境界 | A | 0 |
| 13 | PASETO v4 Ed25519 実装 | A | 0 |
| 14 | Id-Cache / sub vs userId | A | 0 |
| 15 | リレー・WebSocket セキュリティ | A | 0 |
| 16 | 監査ログ完全性 | B | 1 |

**総合評価: A** (問題なし。セキュリティ・設計ともにベストプラクティス遵守)

## 強み

1. **堅牢な認証アーキテクチャ**: 4 層防御 (token verify / Redis TTL / state logged_in / resource ownership)
2. **暗号学的セキュリティ**: PASETO v4 Ed25519 + audience binding
3. **設計思想の一貫性**: CLAUDE.md §1.2 Step 1-8 完全実装
4. **レイヤー分離**: HTTP 認証層、WS セッション層、モジュール実行層、リソース権限層

## 指摘事項

### 中程度 (E2E テスト / 運用ドキュメント)

1. **E2E テストの欠落**: WebSocket 接続 → auth → module_request フローの E2E テスト未検出
2. **operation_logs 失敗時の可視性**: commands.ts:74-77 で console.error、grep/alert 設定例の docs 追記推奨

## 期間のハイライト (b539b04 等)

- PASETO V4 Ed25519: raw 32 byte seed を KeyObject 化 (PKCS8 prefix + createPrivateKey)
- iat / exp を ISO 8601 文字列に修正 (paseto v3.1.4 仕様準拠)
- audience binding 必須化 (confusion-deputy 対策)
