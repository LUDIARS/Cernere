# AUTOFIX.md — Cernere (2026-06-02)

## 概要
- 修正ファイル数: 0
- 変更行数: +0 / -0
- カテゴリ別件数: lint=0 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0 / critical_high=0
- 関連 PR: なし
- 備考: Cernere は認証基盤。bounded fix 候補 (入力バリデーション / 本番ハードニング) はあるが、auth コード変更はローカル green 確認 (smoke/統合テスト未配線) ができない本実行では push しない方針とし、全件手作業に回した。

## カテゴリ別
本日該当なし。

## フラグしたが手作業に回した指摘 (bounded だが auth コードのため要ローカル検証)
- `server/src/config.ts:49-60` / `server/src/auth/paseto.ts:162-163` — env 欠落時の silent fallback を isProduction() で throw (Critical, V-1)。
- `server/src/http/auth-handler.ts:331/334` — hub_url を `new URL()` で validation (High, V-2)。
- `server/src/auth/jwt.ts:97-107` — HS256 token に aud claim 追加 (互換性テスト必須) または廃止計画明記 (High, V-3)。
- `server/src/http/auth-handler.ts:68-69, 122` — password 最大長制限 / email format validation (High, V-4)。
- `server/src/auth/paseto.ts:215-219` — cast 冗長性排除 (lint)。
- `spec/test/test-design.md` — smoke/統合/WS テスト CI 配線計画。
- `server/src/db/schema.ts` — refresh token bcrypt hash 化検討 (スキーマ変更)。

## 関連
- レビュー全文: REVIEW.md / REVIEW_*.md
