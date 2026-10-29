# project-token 発行時の現地 MFA 未検証

- Date: 2026-10-22
- Status: fixed in working tree
- Area: POST /api/auth/project-token
- Severity: High

## Summary

現地 MFA 必須の project でも通常の利用者 Bearer だけでトークン発行へ到達する。

## Evidence

origin/main b783dd5 の `server/src/http/auth-handler.ts` の `projectUserToken` は project の有効性と利用者のサービス利用権を確認するが、現地方針・現地証明を署名前に確認していない。Actio 参照: `actio:1f937dee-ddf8-4ea5-b360-52b49d5aa174`。

## Regression Context

報告された脆弱性。導入時点と実際の不正発行の発生は未確認。

## Cause

発行境界から既存の `projectOnsiteRequirement` と現地 MFA チケット検証が呼ばれていない。

## Fix Requirements

既存の管理者所有方針・kiosk 証明・一回消費を再利用する。利用者・Bearer・project・現在の要求を束縛し、検証失敗時は署名しない。

## Verification

対象 2 ファイルの回帰テスト 24 件成功。C-37 は実行記録 15 件、違反 0 件。契約証跡のため限定実行した。サービス起動・再起動・本番での発行確認は行っていない。

## Follow-up

Revisor local PR で提出する。利用環境への反映は未確認。ユーザーの編集範囲指定に従い、この記録も実装 worktree 内に置く。
