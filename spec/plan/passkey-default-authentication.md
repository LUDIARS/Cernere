# Cernere 端末セッション・運用者によるパスキー回復

2026-09-08 / local PR #886 再仕様化。仕様と実装を更新し、現行 main の Google OIDC・MFA・用途別トークン検証と併用する。旧文書の「パスキー既定・メール認証併存」は本書で置き換える。

## 1. 採用する範囲

- パスキー認証後のブラウザ用 Device Credential、端末一覧と失効、運用者によるパスキー回復を提供する。
- Google OIDC、GitHub、パスワードと Authenticator／メール OTP、公開パスキー新規登録、composite、サービス認証の既存入口を維持する。
- CERNERE_USER_AUTH_MODE による passkey/email/hybrid の三モード、独立した email_sessions、新規アカウント作成を一律 grant 必須にする案は採用しない。
- Device Credential の発行は Cr ブラウザの passkey/login-finish が deviceSession=true を明示した場合に限る（許可 Origin 必須）。新規登録、他端末登録、composite、ネイティブクライアントは従来のトークン交換を使用する。
- 端末とはブラウザプロファイルと origin による保存単位。物理端末の識別や信頼性の証明ではない。
- パスキー回復の grant は既存ユーザー専用。本人確認済み運用者が発行する。公開利用者が grant を要求できる API は作らない。

## 2. 現行認証と Cloudflare の関係

#1516 のトークン用途分離・スキーマ既定値・プロフィール認可、#1520 の Google OIDC、#1531 の MFA が入った main を基点とする。Google の本人認証結果だけから、Cr が検証していない MFA の実施を推定しない。

Cloudflare 企業 SSO は別 PR #1545（参照 head 5348bc8）の責務。本 PR は同 PR の実装を丸ごと取り込まない。共通の AuthenticationEvidence の形を一致させ、端末更新で認証時刻や認証強度が上がらないようにする。#1545 が必要とする企業所属、企業ポリシー、max_age、acr、Cloudflare 向け client 許可は引き続き企業 SSO 側で検証する。

一緒に取り込む際は authentication-evidence、jwt、refresh、auth-code、MFA、OIDC の変更が重なる。認証事実と本 PR の失効チェックを両方残す。Google/Cloudflare の登録や本番への設定注入はこの PR のコード変更とは別の運用作業。

## 3. 認証事実

### SPEC-ENTERPRISE-AUTH-FACTS

AuthenticationEvidence は authTime（秒）、authTimeMs（ミリ秒）、amr、revision（users.mfa_revision）を持つ。WebAuthn の検証成功時だけ passkey の事実を作り、UV 必須で得た pop/mfa を記録する。更新・画面表示・OIDC 同意を新しい本人認証として扱わない。

既存プロバイダー経路に事実が無い場合は未確認のままにする。#1545 の各プロバイダー連携時に検証済み事実を渡す。事実が無いトークンへ一律 MFA を付けない。

### SPEC-DEVICE-SESSION

Device Credential は cdt1、ランダムな device_id、32 byte の秘密値から構成する。公開 ID だけでは認証できない。DB に保存するのは用途別 HMAC、直前世代、generation、rotation_id、有効期限、鍵 ID、root_passkey_id、発行時の auth_epoch、元の認証事実。秘密値の平文を保存しない。

発行時は user 行をロックして、有効な本人のパスキー、現在の epoch/MFA revision を再確認する。秘密値更新でも user → device の順でロックする。パスキー削除・全端末失効・回復と順序を揃える。

ブラウザには短命の user access JWT と HttpOnly Cookie を返し、従来の refreshToken 欄は空文字。access JWT は JavaScript メモリだけに保持する。localStorage に残すのは端末方式の印と表示用ユーザー情報。既存方式の access/refresh 保存値は端末方式への切り替え時に除去する。Google 等の既存方式については、この PR で保存方式を変更しない。

## 4. Cookie と有効期限

本番 Cookie は __Host-cernere-device、Secure、HttpOnly、SameSite=Strict、Path=/、Domain 未指定。開発環境かつ localhost/127.0.0.1/[::1] に限り cernere-device-dev を用い、Secure と永続 Max-Age を付けない。

Device Credential は発行から絶対期限30日。更新しても expires_at と元の authTime を延長しない。Cookie の Max-Age は残存期限以内、access JWT は15分。有効なパスキーを使用して新しく認証すれば、新規 Device Credential を発行できる。

ブラウザの更新・ログアウトは POST と完全一致の許可 Origin を要求する。Origin 無しは拒否する。Cookie の検証エラーは401、競合は409。401で無効な資格情報を除去し、409・通信断・5xxでは再試行に必要な状態を保持する。ネットワーク障害で勝手にパスキーや別端末を失効しない。

## 5. ローテーション

### SPEC-DEVICE-ROTATION

- 初回 secret は暗号学的乱数。検証鍵と次世代導出鍵を master key から HKDF-SHA256 で用途別に導出する。
- HMAC には方式の prefix と device ID を含める。比較は定数時間比較。次世代は device ID、次世代番号、rotation ID から導出する。
- 現行 secret で、直近の更新から30秒未満なら世代を保持する。それ以外は1世代進め、旧 secret に30秒の猶予を設定する。
- 猶予内の旧 secret と同じ rotation ID は、同じ次世代 secret を再生成して返す。DB 更新後の応答消失を吸収する。
- 猶予内でも異なる rotation ID は409。ブラウザは先行処理を待ち1回再試行する。
- 猶予切れや未知の secret は認証を拒否する。公開 ID を知る攻撃者が偽 secret で他人の DB 行を失効させられないよう、これだけで行を失効しない。
- ブラウザ内は single-flight、対応ブラウザの複数タブ間は Web Locks を使う。非秘密の rotation ID は sessionStorage に保持し、成功時だけ除去する。

## 6. 失効の意味

### SPEC-DEVICE-REVOCATION

| 操作 | DB と認証側の効果 |
|---|---|
| このブラウザのログアウト | Cookie が示す自分の Device Credential のみ失効。Cookie を削除。パスキーは維持 |
| 指定端末の失効 | 本人所有の指定行を失効。派生 JWT・refresh・WS・OIDC は次の認可確認で拒否 |
| パスキー削除 | 論理失効と、そのパスキー由来の Device Credential の失効を同じトランザクションで実施。最後の有効パスキーは削除不可 |
| 全端末からログアウト | 全 Device Credential 失効、refresh_sessions 削除、auth_epoch と mfa_revision を加算 |
| パスキー回復 | 固定されたパスキー範囲を失効、新規キー登録、全端末と refresh を失効、両 revision を加算、grant 消費 |

user JWT は署名・用途に加えて現在のユーザー、role、auth_epoch、存在する mfaRevision を確認する。deviceId 付きの場合は active root、所有者、端末の期限・失効・鍵世代、元の認証時刻/amr/revision も確認する。発行も検証も非同期。トランザクション内の発行には同じ DB executor を使う。

auth-code の派生トークンと refresh に元の deviceId・epoch・認証事実を渡す。OIDC コードと opaque access token に認可元を保存し、交換と userinfo でも現在状態を確認する。認可元情報のない旧 OIDC コード/access token は再認証を要求する。

Redis の user WS セッションは authenticationVersion=3 と認可元を保存する。復帰、受信メッセージ、コマンド実行、通知・relay 配信時に現在状態を確認する。アイドル接続も30秒ごとに確認し、失効後の ping を送らず切断する。WS 自体の期限は既存の7日以内で、端末の絶対期限を越えた認可はしない。処理中にすでに認可された操作を取り消すことは保証しない。

この失効保証は Cr が認可を確認する経路に適用する。外部サービスが受領済みの ID token / PASETO をオフライン検証する場合や、Cloudflare 自身が発行済みの Cookie について、Cr の操作だけで即時失効したとは扱わない。外部側の期限・失効契約はそのサービスの責務。#1545 の企業セッションは元の MFA revision を照合する。

## 7. 運用者による回復

### SPEC-DEVICE-RECOVERY

1. 管理者は Cr の /account-recovery で対象ユーザー ID を指定し、別窓口での本人確認と失効範囲を確認する。現在の UI は既存の全パスキーの失効を選ぶ。
2. 発行・取消には接続済み user WS と対象 action/resource/session に束縛した単回の fresh action proof を要求する。サーバーで現在の admin role を確認する。
3. token は32 byte 乱数、15分有効、SHA-256 digest のみ保存。purpose=recover_user、対象ユーザー、失効対象、発行者と双方の auth_epoch、発行者 mfa_revision を記録する。API は全キー／指定キー一覧のいずれか一方だけ許可する。
4. 管理者画面は URL を一度表示する。token を URL fragment に載せ、回復画面はメモリへ読み込んだ後に履歴から除去する。発行者が本人確認した窓口で対象者へ渡す。ブラウザ保存領域へ token を保存しない。
5. 公開 /recover は回復 token を提示し recovery-begin で専用 WebAuthn ceremony を開始する。Redis に challenge、対象、grant digest、期限を保存する。ceremony は最大5分かつ grant の残存期限以内。
6. recovery-finish は GETDEL で ceremony を単回消費し、challenge/origin/RP ID/UV を検証する。対象と失効範囲はクライアント入力で差し替えられない。
7. user → grant の順でロックし、grant の未使用・未失効・有効期限、対象 epoch、発行者の現 role/epoch/MFA revision を再検証する。指定旧キーの失効、新規キー登録、全セッション失効、grant 消費を1トランザクションで実施する。
8. 復旧完了の応答は recovered=true のみ。通常セッションを発行せず、新しく登録したパスキーでログインする。

既存の device-link は利用者本人の追加登録として維持する。発行元の認可状態を Redis grant と後続 ceremony に保存し、開始時と登録トランザクション内で再確認する。旧形式のリンクは再発行を要求する。回復用 registration_grants と取り違えない。

## 8. UI と API

| 入口 | 認証・操作 |
|---|---|
| POST /api/auth/passkey/login-finish | 有効化時のみ Device Credential + メモリ access JWT |
| POST /api/auth/device/session | Cookie、許可 Origin、X-Cernere-Rotation-Id。毎分60回/IPまで |
| POST /api/auth/device/logout | Cookie、許可 Origin。現在端末だけログアウト |
| device_session.list | 接続済み WS。本人の有効な端末と現在端末 ID |
| device_session.revoke / revoke_all | 接続済み WS + fresh action proof。REST の revoke/revoke-all は403 |
| account_recovery.issue / revoke | 接続済み WS + fresh action proof + 現在の admin role |
| POST /api/auth/passkey/recovery-begin / recovery-finish | 回復 token、専用 ceremony。毎分15回/IPまで |

/devices は登録・最終利用・有効期限と現在端末を表示する。現在端末失効後はログアウトする。別タブでユーザーが切り替わるかログアウトした場合、古いアカウントの WS と画面を保持せず再読込する。

Cr のブラウザ user WS は既存サーバーが対応する bearer subprotocol を使い、URL に token を含めない。全クライアント向けの一回限り WS ticket への統一は本 PR の仕様ではない。

## 9. データと移行

| migration | 内容 |
|---|---|
| 050_device_credentials.sql | Device Credential の表・索引 |
| 051_registration_grants.sql | 用途別 grant の表・対象制約 |
| 052_auth_epoch_and_passkey_revocation.sql | users.auth_epoch / webauthn_user_id、passkeys.discoverable / revoked_at |
| 053_device_authentication_state.sql | Device/refresh の認証事実・epoch・由来、grant の発行時 revision、旧 Device 行の失効 |

現行 MFA の047、#1545 の048との同名番号衝突を避ける。旧 #886 の047/048/049名で適用済みの場合も、追加 DDL は IF NOT EXISTS。新053で認証事実のない Device 行を再登録対象にする。旧 grant は発行時 revision が無いので使用を拒否する。既存 users/passkeys の削除や型変更はしない。

既存パスキーの WebAuthn user handle（ユーザー UUID の UTF-8 bytes）を変更しない。webauthn_user_id は旧互換列として保持する。discoverable の旧行の false は「非対応と確定」の意味に使わず、既存 credential を除外しない。

旧 user JWT は auth_epoch が0のユーザーに限り epoch 未記録を0として扱う。全端末失効を一度でも実施したユーザーには通さない。旧 WS、旧 OIDC code/access、旧 device-link は再認証または再発行。起動時に全既存ユーザーを暗黙に新しい信頼状態へ昇格させない。

## 10. 有効化と運用

- CERNERE_DEVICE_SESSIONS_ENABLED は初期値 false。既存認証だけで稼働できる。
- 有効化前に上記 migration の適用履歴、HTTPS origin/RP ID、CERNERE_AUTH_SESSION_KEY（32 byte の base64url）と CERNERE_AUTH_SESSION_KEY_ID の登録を確認する。鍵は Infisical 等の secret store から注入する。
- enabled=true で鍵が未設定・不正なら起動前検証で失敗する。稼働中の発行失敗を既存 refresh 方式へ暗黙に切り替えない。
- master key を変えるときは key ID も変更する。旧 ID の Device 由来 JWT と Cookie は拒否される。全通常セッションも止める必要がある事故対応では、別途全端末失効を実施する。secret をログや PR に記載しない。
- enabled=false に戻すと Device 認証は拒否する。利用者は既存のパスキー等で再ログインする。
- この実装作業では migration 実行、鍵登録、機能有効化、サービス起動・再起動を行わない。

## 11. 審査・検証項目

- 静的確認: server / frontend の TypeScript 型チェック、差分と migration 番号、非同期 JWT 呼び出し元。
- テスト定義: token 構文・用途別鍵、rotation の現行/旧世代/同 ID/競合/期限、REST 管理操作の拒否、現ユーザー/端末/鍵/認証事実の失効、回復 grant の用途/単回性/対象/運用者 revision。
- Revisor で確認する統合項目: DB トランザクションの rollback、同時 recovery-finish が1件のみ成功、回復とログイン/rotation の競合、WS 復帰と通知抑止、旧 migration 適用状態からの更新。
- 人間の動作確認: 複数タブ・応答消失・Cookie 再取得、WebAuthn 登録、現在/別端末失効、運用者回復、Google/MFA と #1545 併用。
- この作業では単体・統合・起動・ブラウザ動作テストを実行しない。定義追加や型チェックを Test OK の代用にしない。
