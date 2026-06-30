# AUTOFIX.md

## 概要
- 修正ファイル数: 0
- 変更行数: +0 / -0
- カテゴリ別件数: lint=0 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0
- 関連 PR: なし

## 修正対象なし

直近 9 commits は PASETO ISO timestamp / Ed25519 KeyObject 修正など実装的に堅牢で、自動修正候補は極めて限定的。

## フラグしたが手作業に回した指摘 (= 自動修正の範囲外)

- packages/id-cache/src/cache.ts:105-117 — H-1 (sub vs userId) コメント整理推奨
- docs/relay_design.md:45 — Rust pseudo-code であることを明記推奨
- E2E テスト整備 (vitest/uvu) — REVIEW_QUALITY.md §1
- ESLint 設定追加 — REVIEW_IMPLEMENTATION.md §1
- 運用ランブック (Redis/DB 障害) — REVIEW_QUALITY.md §3

## 関連
- レビュー全文: REVIEW.md / REVIEW_*.md
- 修正 PR diff: なし
