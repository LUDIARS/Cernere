# REVIEW_IMPLEMENTATION — Cernere

**評価: B**

## 実装正確 (良好)
- JWT 署名・PASETO Ed25519・claim 型定義・WS 認証・4 層防御 dispatch は robust
- seedToPrivateKey() で PKCS8 prefix + seed → KeyObject 昇格 (paseto v3.1.4 互換)
- verifyProjectTokenPaseto で expectedAudience 必須
- operation_logs write failure を catch + error log (audit trail リスク認識)

## 実装課題

| # | 該当 | 内容 |
|---|------|------|
| a | server/src/http/auth-handler.ts:122 | email format validation なし (@ 含有確認すら無い) |
| b | server/src/http/auth-handler.ts:68-69 | password 最大長制限なし (DoS via long password) |
| c | server/src/http/auth-handler.ts:334 | hub_url フォーマット検証なし |
| d | server/src/auth/paseto.ts:215-219 | cast 冗長性 (型整理可能) |

## 型安全性
- claim interface で token 種別を distinct type として区別
- jwt.ts / paseto.ts は pure で testable

**総合: B**。コア実装は正確。入力バリデーション層の補強が必要。
