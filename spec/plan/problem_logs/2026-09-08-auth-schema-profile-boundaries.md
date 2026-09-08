# 認証トークン・DDL 既定値・サービスプロフィールの境界不足

- Date: 2026-09-08
- Status: fixed in branch / review pending
- Area: authentication / project schema / common profile
- Severity: P1（ソース上の指摘。被害・実環境での悪用は未確認）

## Summary

neco の指示で3件を修正する。MFA 待ち token が通常認証へ流用でき、サービスのスキーマ既定値が SQL 式へ入り、共通プロフィール操作がサービス別認可を通らない。

## Evidence

基点 Cernere main 534e56b。jwt.ts の generateMfaToken / verifyToken、ws/auth.ts の resolveWsAuth、http/oidc-handler.ts の handleOidcApprove。project/schema-migrator.ts の escapeDefault / sql.unsafe。ws/project-dispatch.ts の profile.get / profile.update。

追加で composite-handler.ts の compositeMfaVerify は method / code の存在しか見ず、照合前に MFA 成功を記録する。MFA のコード発行・検証器は未配線で、db/schema.ts にもその状態が明記されている。

## Regression Context

再発の証拠はなく、今回の静的レビューで見つけた既存の欠陥。Genius の判断カード照会は応答 schema の decidedBy 不一致で失敗したため、現行コードと spec の未宣言拒否・管理者所有 grant の方針に従う。

## Cause

署名の妥当性と token の用途を混同している。既定値を型付きの値として処理せず SQL の一部としている。サービス認証を対象ユーザー・項目・操作の許可として扱っている。

## Fix Requirements

- 通常 user / tool / MFA の用途を区別し、通常 WS・REST・OIDC は MFA token を拒否する。用途を証明できない旧 token / WS session は受理しない。
- 未配線の MFA 完了処理を成功扱いせず、明示エラーにする。
- 既定値を型に応じて検証し、DDL 実行より前に全項目を検査する。数値の範囲・JSON の引用符・空文字を扱う。
- プロフィールの grant は管理者所有とし、対象ユーザー・項目・操作を検査する。privacy / opt-out、更新後の応答、自己付与防止も扱う。

## Verification

ユーザー方針に従いテストは追加・実行していない。必要な回帰確認条件: MFA/旧tokenの通常入口拒否、toolの専用入口、旧session再利用拒否、SQL式・範囲外・引用符、grant無し・他user・他project・readのみ・非公開項目・拒否時の部分更新なし、権限取消と古い schema auto-sync の競合。server の `tsc --noEmit -p server/tsconfig.json` は exit 0。差分と各呼び出し元を静的確認した。実環境での動作確認結果ではない。

## Implemented

JWT に用途を必須化し、旧 Redis session を再利用しない。composite の照合なし MFA 成功を明示エラーへ変更。DDL 既定値を型付き serializer に統一。プロフィールは管理者所有の user / read / write grant、privacy、opt-out を検査し、更新応答を項目名だけに限定。定義の同時変更は条件付き更新で検出し、取り消した grant を古い同期が戻さない。プロフィール・grant の SQL parameter は開発ログでも伏せる。

API 契約・移行条件は [修正仕様](../../interface/auth-schema-profile-boundaries.md)、Cloudflare との企業認証統合は [SSO 提案](../enterprise-sso-cloudflare-cernere-20260908.md) を参照。

## Follow-up

マージ・反映時には再ログインとプロフィール利用サービスの明示 grant 設定が必要。実環境の操作、テスト、restart、migration は本作業では実行しない。
