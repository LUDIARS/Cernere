# AUTOFIX — Cernere (2026-05-29)

## 概要

- 修正ファイル数: 0
- 変更行数: +0 / -0
- カテゴリ別件数: lint=0 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0 / critical_high=0
- 関連 PR: なし

## カテゴリ別

### lint warnings (0 件)
- なし

### typo (0 件)
- なし

### 未使用 import (0 件), dead code (0 件), .gitignore 漏れ (0 件), TOC ずれ (0 件)
- なし

### Critical / High 修正 (0 件)
- なし (本日対象 commit は派生フィールド追加のみで、 機械修正対象なし)

## フラグしたが手作業に回した指摘 (= 自動修正の範囲外)

- `server/src/project/schema.ts` — [High] endpoint.frontend_url に `z.string().url()` validation 追加 (REVIEW_MISSING_FEATURES §2 参照)。 既存 schema が判明している必要があり、 スキーマファイル全体の構造調査が必要なため手作業
- `server/tests/` 配下 — [High] テスト基盤 (jest/vitest + CI) 新設 (REVIEW_QUALITY §1 参照)。 大型 task で「新機能実装」 範疇のため自動修正範囲外
- `spec/project-management.md` — [Medium] Memoria Hub Shell probe 仕様 (retry/backoff/fallback) の追記。 設計判断要のため手作業

## 関連

- レビュー全文: REVIEW.md / REVIEW_*.md
- 修正 PR diff: なし
