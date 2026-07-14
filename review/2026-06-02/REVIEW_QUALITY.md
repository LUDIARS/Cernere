# REVIEW_QUALITY — Cernere

**評価: B**

## 強み
- エラーハンドリング: AppError モデルで status code 伝播
- 型安全: claim interface で token 種別を distinct type 区別
- コード再利用: jwt.ts / paseto.ts は pure で testable
- ログ出力: sensitive data (token) を除外し必須 insight のみ (devLog は適切に曖昧化)

## 改善案

| # | 該当 | 内容 |
|---|------|------|
| a | server/src/http (parseBody) | Zod で request body schema 定義 (現状 type-safe でない) |
| b | redis session/state 操作 | interface abstraction (mock 可能化) |
| c | server/src/auth/paseto.ts:215-219 | cast 冗長性排除 |

## テスト戦略
- token 層 22 本は充実だが、smoke/統合/WS は未配線 (REVIEW_MISSING_FEATURES 参照)
- CI に typecheck はあるが、テスト matrix 配線が課題

## ドキュメント
- spec/test/test-design.md で観点定義あり (実装 gap あり)
- legacy HS256 廃止計画の文書化が必要

**総合: B**。コード品質・ログ衛生は良好。Zod 導入とテスト配線が次の改善点。
