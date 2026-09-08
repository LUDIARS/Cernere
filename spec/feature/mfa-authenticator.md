# Authenticator とメール OTP による MFA

2026-09-08。Cr のパスワードログインに追加要素を実装する。Qs の
`src/services/invoice-share-acceptance-service.ts` と `src/db/invoice-share-challenge-repo.ts`
を参照し、期限・試行回数・発行回数の制限、コードの非平文保存、一回限りの消費を採用する。
Qs の請求書・受領者・パスキー登録 grant は Cr へ持ち込まない。

## SPEC-MFA-TOTP

Authenticator アプリ用の TOTP は RFC 6238 / HOTP の HMAC-SHA1、6桁、30秒周期。
利用者ごとの160 bitランダム鍵を Base32 で表現する。許容窓は前後1周期。
`otpauth://totp` の issuer は Cernere。プロフィールの設定画面で QR と手動入力キーを表示し、
アプリが出したコードの検証後にのみ有効化する。QR はブラウザ内で生成し外部へ送信しない。
Google Authenticator / Microsoft Authenticator 等の標準 TOTP アカウント登録を対象とし、
各アプリの実機確認は別途必要。プッシュ承認や企業 MFA 証明とは別の機能。

鍵は `encryptSecret` で暗号化して一時 Redis / PostgreSQL に保存する。
設定完了後の secret の再表示 API は設けない。`users.totp_last_step` を行ロック下で前進させ、
同じタイムステップを別ログイン・並行要求・再起動後に再利用させない。

## SPEC-MFA-CHALLENGE

REST login、guest WS、composite REST / project WS で、パスワード照合後に MFA challenge を返す。
通常アクセストークン・refresh token・auth_session はまだ作らない。
challenge は32 byte乱数、Redis にはその SHA-256 をキーとして5分保存する。
用途 (rest / guest / composite / manage / settings)、ユーザー、project WS の projectKey、設定状態に束縛する。
管理用 challenge / grant はさらに開始した Bearer token に束縛する。
旧 MFA JWT は本フローで受理せず、通常認証としても受理しない。

検証は challenge あたり5回、ユーザーあたり15分で20回まで。
発行はユーザーあたり15分で10回まで。再発行でユーザー総試行数はリセットしない。
コード検証・最新設定確認・一回消費が完了してから通常ログインへ進む。
消費は Redis の原子的処理、TOTP カウンタは DB の行ロック・transaction を使用する。
Redis 消費後に DB が失敗した場合はログインを成功扱いせず最初からやり直す。

## SPEC-MFA-EMAIL

登録メールアドレスだけに6桁コードを送る。宛先を要求本文から受け取らない。
コードは challenge に束縛した HMAC-SHA256 のみ Redis へ保存する。
再送は60秒間隔、challenge あたり3回、ユーザーあたり15分で5回まで。
再送しても challenge の期限・試行数は延長しない。再送後は旧コードを無効にする。
送信失敗ではコードを破棄してエラーとし、ログ表示・固定コードへの代替を行わない。
SES または SMTP の明示設定が必要。初回有効化にも登録先へ送ったコードの照合が必要。

## SPEC-MFA-SETTINGS

プロフィールに MFA 専用設定セクションを設ける。
設定変更は通常 user Bearer に加えて、本人のパスキーによる action proof、または
再入力したパスワードと現在有効な MFA の照合を要求する。
パスワードもパスキーもないアカウントは、先にパスキーを登録する。
manage/begin のパスワード照合はユーザーあたり15分で10回まで数える。
単回使用の action proof を消費するパスキー経路と、照合成功はこの回数に数えない。
本人が通常の設定変更を続けたときに自分の MFA 設定から締め出さないため。
認証後の management token は一回の変更に限り有効、5分で失効する。
パスキーによる本人確認は Authenticator 紛失時にも利用できる。

未確認の TOTP 鍵は本登録せず、登録済み鍵を setup で上書きしない。
設定保存は行ロックを取り、`users.mfa_revision` を増加する。
鍵・宛先・パスワード・設定状態が変わった古い challenge / grant は拒否する。
変更時に既存 refresh session を失効する。既発行の短期 access token と既存 WS の
全即時失効を追加した機能ではない。企業セッションの期限・失効は Cloudflare 統合の別タスク。
SMS は未実装のまま有効な選択肢として表示しない。

### API

すべて `/api/auth/mfa` 配下。応答は `Cache-Control: no-store`、本文は最大4 KiB。
status だけ GET、それ以外は POST。設定 API は user Bearer 必須。

| 操作 | 必須入力 | 結果 |
|---|---|---|
| status | user Bearer | 登録状態・利用可否。鍵や OTP は含めない |
| manage/begin | password、または mfa.manage / 自分の user ID に束縛した action proof | 現在の MFA challenge、または managementToken |
| manage/send-code / manage/verify | mfaToken・method、検証時は code | 管理用コード送信 / managementToken |
| totp/setup | managementToken | 登録前の secret と provisioningUri |
| email/setup | managementToken | 登録メールへのコード送信 |
| totp/enable / email/enable | managementToken・code | 登録を確認して有効化 |
| totp/disable / email/disable | managementToken | 確認済みの本人操作として解除 |
| send-code / verify | REST login から得た mfaToken・method、検証時は code | 送信 / REST の通常ログイン結果 |

composite は `/api/auth/composite/mfa-send-code` / `mfa-verify` を利用する。
guest WS / project WS は `auth.mfa-send-code` / `auth.mfa-verify`。
コード用 payload は `{mfaToken, method, code?}`。composite の fingerprint は検証後の
既存 auth_session WS で渡す。projectKey は認証済み project WS の文脈を利用する。

## 保存と反映

`migrations/047_mfa_authenticator.sql` は `users.totp_last_step` と `users.mfa_revision` を追加する。
実行前に migration を適用する。既存鍵を平文へ戻す移行や、既存 MFA の自動無効化は行わない。
`CERNERE_SECRET_KEY` と、メール利用時の SES / SMTP 設定は既存の秘密管理から投入する。
Google / GitHub / passkey は既存の別認証経路を維持する。この MFA の適用対象はパスワード経路。
Cloudflare 向け `amr` / `auth_time` の発行をこの変更で完了扱いしない。

## 確認

ユーザー指示に従いテスト・起動・再起動・稼働 DB の migration は未実行。
server / frontend の TypeScript `tsc --noEmit` と追加した TOTP テスト定義の型検査は成功。
型検査で見つかった face-photo の旧 tokenType 判定も、現行の user_access 契約に整合した。
差分を静的確認し、Revisor local PR に提出する。
RFC 公開検証値・時刻窓・コード再利用・URI エンコードのテスト定義を追加するが、こちらでは実行しない。
後日の確認条件: QR登録、登録前の拒否、正誤コード、期限、再送、並行消費、TOTP再利用、
異なるproject/用途での再利用、設定変更後のchallenge、メール送信失敗、各ログイン経路。

参照: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)、
[Authenticator Key URI](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)。
