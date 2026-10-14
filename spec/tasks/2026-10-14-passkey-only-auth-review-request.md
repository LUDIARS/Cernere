# レビュー依頼: Cernere パスキーのみの認証 (攻撃耐性・ログイン通知)

## 1. 進め方

同じ依頼文を Fable と Astra に別々に出す二本立てのレビュー。もう一方の成果は見ないこと。
親セッションが 2 本を突き合わせて設計を確定する。

## 2. 人間 (neco) の指示の原文

> ログイン時の攻撃耐性を鑑みて処理を変える。
> パスキーのみの初期設計にする。
> しかし最初のログイン時にパスキーでアカウント作ると思うんだけど、
> これ端末変えたときに詰むので、初回ログインの端末がPCだった場合はスマホログイン用のQRを発行してQRログインからのスマホのパスキーをCrに登録させる。スマホだった場合は特に何もしない。
> 名前は初回ログイン後に入れる。
> 登録とログインの区別をしない。
> そのためユーザー登録時のUDID+ハッシュを埋め込んだリカバリー用データ(QR画像)をユーザにダウンロードさせる。
> メールアドレスはMFA用のレガシーアクセサとして任意都市収集しない形に変更。

既存のメール+パスワード・Google・GitHub ログインの扱い: 「即時に全廃」(neco 回答)。

> この設計をFableとAstraにレビューさせて、攻撃耐性についての知見をもらう。
> ログインアラートをどうにかして実装したいので何か方法を考える。
> DiscordまたはGoogleによる代行通知で考える

## 3. 親の解釈

設計書に書いた。違うと思えば指摘すること。特に「UDID+ハッシュ」をユーザー ID + 秘密値 (サーバーは HMAC digest のみ保存) と解釈した点、edge assertion (Cloudflare Access 企業 SSO) を廃止対象外とした点。

## 4. 前提として読むもの (絶対パス)

- 対象設計: `E:/Document/Ars/Cernere/.wt-passkey-only/spec/plan/2026-10-14-passkey-only-authentication.md`
- 既存の端末セッション・運用者回復: `E:/Document/Ars/Cernere/.wt-passkey-only/spec/plan/passkey-default-authentication.md`
- 認証フロー一覧: `E:/Document/Ars/Cernere/.wt-passkey-only/spec/interface/auth-flows.md`
- 実装: `E:/Document/Ars/Cernere/.wt-passkey-only/server/src/http/passkey-handler.ts`、`server/src/http/passkey-recovery-handler.ts`、`server/src/auth/` 配下、`server/src/http/oauth-handler.ts`、`packages/composite/src/ui/`

## 5. レビューしてほしいこと

独立に考えてよい。親の設計と違う結論になってよい。

1. **攻撃耐性**: 設計全体の脅威モデルの漏れ。特にリカバリー QR (bearer 資格情報になる)、onboarding token、PC→スマホ QR (device-link) の盗み見・中継・フィッシング (QR を使った AiTM、consent phishing)、二重アカウント、アカウント列挙、レート制限の粒度。
2. **リカバリー QR の方式**: `CRRC1.<userId>.<secret>` + HMAC digest の是非。userId を QR に含めることの影響、単回使用・使用時の全失効の妥当性、印刷/保存の UX と保管上の危険、代替案 (例: 複数コード、PIN 併用、時間差での有効化 = 回復の待機期間と通知での取消) の比較と推奨。
3. **登録とログインの統合**: get → 失敗時に明示操作で create、という流れの穴。conditional mediation の利用可否、WebAuthn Signal API 等で改善できる点。
4. **即時全廃の移行リスク**: パスキーを持たない既存ユーザー、composite を埋め込んだ他サービス、OIDC 提供経路への影響と、設計に足すべき安全策。
5. **ログイン通知 (Discord / Google の代行通知)**: 実現方式を具体的に。Discord Bot DM の到達条件 (共通サーバー・DM 許可)・Bot の所有・レート制限、Google 経由 (連携済み Google アカウントのアドレスへの送信、Gmail API、Google の仕組みで使えるもの) の比較。通知すべき出来事、内容 (載せてはいけない情報)、「自分ではない」からの封じ込め導線、通知自体を悪用される危険 (通知フィッシング・通知先の乗っ取り・通知先変更の通知)。推奨案を 1 つ選ぶ。
6. **その他**: 上記以外で、この設計が攻撃耐性の点で見落としていること。

## 6. 成果物

- Fable: `spec/plan/2026-10-14-passkey-only-authentication-review-fable.md`
- Astra: `spec/plan/2026-10-14-passkey-only-authentication-review-astra.md`

章立て: 結論 (重大度順の指摘 5〜10 個) → 1〜6 の各論 (指摘・根拠・推奨する変更) → ログイン通知の推奨方式の詳細 → 設計書へ入れるべき修正の一覧 → 未決事項 (推奨つき)。

- 実装しない。レビュー文書以外を変更しない。
- 自分のブランチにコミットし、要点 5 行を報告して終了指示を待つ。
- **PR は出さない。**
