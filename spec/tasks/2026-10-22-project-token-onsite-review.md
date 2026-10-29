# project-token 発行前に現地 MFA を検証する

## 実装内容

現地 MFA 必須の project への user×project トークン発行で、既存の管理者所有方針と kiosk 証明検証を適用する。未確認の要求には署名せず現地 challenge を返し、利用者・Bearer・project に束縛された証明を一回消費してから署名する。現在の assurance と施設要求がチケットから変わった場合も拒否する。

再利用探索: `projectOnsiteRequirement`、`beginMfaChallenge`、`readMfaTicket`、`verifyMfaChallenge`、`httpActionBinding` を採用した。通常の `authentication.amr` は現地確認を区別できないため代用しない。新たな現地方針や署名方式は追加しない。既存の現地 challenge に専用 purpose を与え、通常ログインとの交換を拒否する。

Actio: `actio:1f937dee-ddf8-4ea5-b360-52b49d5aa174`。origin/main b783dd5 起点。仕様は `spec/setup/service-registration.md` §3、テスト計画は隣接の `2026-10-22-project-token-onsite-test-plan.json`。

## 受け入れ条件

C-37 authorizeProjectTokenOnsite(input): 現地MFA必須のprojectでは証明未提示ならchallengeだけを返し、対象利用者・Bearer・project・現在の要求に束縛された現地証明を一回消費した場合だけ発行を許可する

## 検証

`LOG_WEAVER=1` で対象の `onsite-mfa-flow.test.ts` と `project-token-onsite.test.ts` を実行し、24 件成功。契約 C-37 は 15 回観測、違反 0 件。署名前の関門、証明待ち、期限切れ、再利用、束縛違い、方針変更、通常ログインチケットの流用を検証した。テスト計画に対応する回帰テストを同じ変更に含めた。

既存の他 36 契約は本タスクの検証対象外であり、今回の集計窓では未観測。サービス起動・再起動、全体テスト、本番反映は未実施。現地 MFA 必須の呼出元は challenge 往復と `mfaToken` 再送に対応する必要がある。

## 提出境界

コミットと Revisor local PR 提出まで。マージ・自動マージ設定・共有 main 更新・push は実施しない。
