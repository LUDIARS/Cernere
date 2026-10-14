# 依頼: パスキーのみ認証の実装に対する攻撃耐性の検証 (Fable)

## 人間 (neco) の指示の原文

> 攻撃耐性を検証
> Crはサービス共通にんしょうでもあり他人の公開データにアクセスする権限もある。

## 対象

- 作業ブランチ: `E:/Document/Ars/Cernere/.wt-passkey-only` の `feat/passkey-only-auth` (main からの差分 `git -C E:/Document/Ars/Cernere/.wt-passkey-only log --oneline main..HEAD`)
- 設計: `E:/Document/Ars/Cernere/.wt-passkey-only/spec/plan/2026-10-14-passkey-only-authentication.md`
- 主な実装: `server/src/auth/{device-pairing,passkey-candidates,recovery-code,recovery-request,retired-login,admin-bootstrap,webauthn-policy}.ts`、`server/src/http/{passkey-handler,recovery-code-handler,auth-handler,oauth-handler,composite-handler,bearer-user}.ts`、`server/src/ws/guest.ts`、`server/src/notify/*.ts`、`migrations/065〜067`

## やってほしいこと

攻撃者の立場で実装 (設計ではなくコード) を読み、成立する攻撃を探す。独立に考えてよい。

1. 認証の迂回: 廃止した入口 (password / OAuth ログイン / guest / composite・project WS の login・register・passkey-signup) が別経路で残っていないか。OAuth callback が link 以外で成功しないか。
2. 端末追加 (pairing): 候補が承認無しで有効化される経路、承認 proof の束縛 (resource) の抜け、epoch・期限・並行実行の競合、照合番号の推測、別ユーザーの pairing を操作できないか。
3. リカバリー QR: 照合・世代・待機・取消・確定・運用者回復との競合、admin 除外の抜け、候補キーで action proof / login を通せないか、列挙・DoS。
4. 通知: 宛先の乗っ取り・偽装、確認番号の総当たり、outbox の重複・欠落、通知文への注入 (Discord mention 等)、通知の洪水。
5. Cr が「サービス共通の認証」であり「他人の公開データにアクセスする権限を持つ」ことを踏まえ、新規アカウントを誰でも即時に作れることで広がる攻撃面 (他サービスへの横展開、他人データの閲覧、relay、組織・プロジェクト操作など) を具体的な経路 (ファイル・関数) つきで挙げる。
6. その他、実装上の誤り。

成立すると判断したものは「前提・手順・影響・修正案」を書く。成立しないと判断したものも、確かめた根拠を短く書く。

## 成果物

`spec/plan/2026-10-14-passkey-only-attack-verification-fable.md` に、重大度順の指摘一覧 → 各論 → 修正案の一覧 を書く。

- 実装を変更しない。検証文書以外を変更しない。テスト・サービス起動はしない。
- 自分のブランチにコミットし、要点 5 行を報告して終了指示を待つ。PR は出さない。
