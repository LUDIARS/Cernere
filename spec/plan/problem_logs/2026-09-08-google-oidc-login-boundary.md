# Google ログインの OIDC 検証とフロント受け渡し不足

- Date: 2026-09-08
- Status: fixed in working tree / review pending
- Area: Google authentication / frontend OAuth handoff / Cr OIDC continuation
- Severity: 認証の信頼境界とログイン完了に影響。実環境での被害は未確認。

## Summary

Google OIDC を Cr の認証元として使う依頼に伴い、既存 Google ログインを確認した。
openid scope は要求するが ID token を利用せず、userinfo の id/email によって認証を進めていた。
通常ログイン後の authCode を現在の frontend が消費する経路と、Cr OIDC 同意画面への戻りも不足していた。

## Evidence

基点 Cernere main 534e56b。`http/oauth-handler.ts` の googleLogin / googleCallback は nonce / PKCE がなく、
token 応答の id_token を確認せず `/oauth2/v2/userinfo` を呼ぶ。
callback が返す `?authCode=` を `frontend/src/contexts/AuthContext.tsx` は処理していない。
`OidcConsentPage` で Google ログインを選んでも元の request_id が認証後の遷移に渡らない。
これらはソースの静的確認結果であり、起動テストや侵入試験の結果ではない。

## Regression Context

再発時点を特定する根拠はない。今回確認した既存実装の不足として扱う。
Genius の判断カードは正規 cwd から再照会したが、応答の decidedBy が schema に合わず利用できなかった。
Google 公式仕様と現行 Cr の state / account-link / composite 許可先の契約を根拠にした。

## Cause

Google API 利用の token 処理と本人認証が混在し、OIDC の検証済み identity を独立した境界にしていなかった。
通常・埋め込み・外部 OIDC 同意の各遷移に、完了先の接続とブラウザの照合が不足していた。

## Fix Requirements

- state cookie の一致、短命で一度限りの Redis request、nonce と PKCE S256 をすべて確認する。
- Google の公開鍵、RS256、issuer、client audience、azp、必須期限、sub、確認済み email を検証する。
- 設定時は署名付き hd を照合し、メール末尾だけで Google Workspace 所属を判断しない。
- 本人特定は Google sub と既存 google_id で行う。email 一致による既存アカウントへの自動結合をしない。
- Google API token をログインのために保存せず、Cr の短命コードへ交換する。
- 通常 callback は開始したタブを確認し、一度だけコードを交換して Cr OIDC 同意へ戻れるようにする。
- Google 認証の成功を一律に企業 MFA 成功とは扱わない。

## Verification

server / frontend の `tsc --noEmit -p <各 tsconfig.json>` はともに exit 0。
差分の静的確認を実施し、資料の UTF-8 / JSON / リンクも確認する。
単体・統合・起動テストはユーザー方針により追加・実行しない。
将来の回帰確認条件: 改ざん・別 client・nonce 不一致・期限なし/切れ・未確認 email・hd 不一致を拒否、
旧/使用済み request の拒否、link / composite の維持、別タブの callback を拒否、
StrictMode でも交換が一度、Google から Cr OIDC の同意画面へ復帰、トークンがログへ出ないこと。

## Follow-up

Google client の設定・実環境の有効化・Cloudflare 設定変更は本作業では行わない。
既存 PR #1516 の MFA 用途分離は別 PR として維持し、本 PR からマージしない。
