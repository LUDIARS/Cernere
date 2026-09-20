# Cloudflare と Cr の企業認証

Cr の本人認証を Cloudflare Access の Generic OIDC IdP として使い、企業アプリの入口制御と
Cr の組織内認可を接続する。Okta は使わない。通常の Cr ログインと企業セッションは用途を分ける。
Google による本人認証は既存実装を使うが、Google のログイン結果だけで MFA 実施を推測しない。

## SPEC-ENTERPRISE-AUTH-FACTS

`authentication-evidence.ts` は検証が完了した認証方法、秒単位の `authTime`、同じ時刻の
`authTimeMs`、`users.mfa_revision` を保持する。パスワード単独は `pwd`、パスワード +
Authenticator/メール OTP は `pwd otp mfa`、user verification 必須のパスキーは `pop mfa`。
パスキーの同期可否・ハードウェア耐性は推測しない。

JWT、composite session、auth code、refresh session は同じ情報を引き継ぐ。
同意や refresh は認証時刻を更新しない。旧セッションや証拠のない OAuth ログインには
認証時刻・MFA の claim を付けない。企業認証ではパスキー、またはパスワード + MFA で再認証する。
MFA 設定変更後は旧 revision の認証情報を拒否する。

認証事実は端末セッション側の失効状態 (`users.auth_epoch`、`users.role`、
`users.mfa_revision`、`device_credentials`) と同じ経路で検査する。事実の正本は
1 つだけ置き、access token / auth code / access token record には
承認したセッション (`UserSessionState`) の形で束縛する。事実を二重に保管しない。
トークン発行時は読み取った `authEpoch` を渡し、発行の直前に一括失効が起きた場合は
新しい世代で黙って発行せず失敗させる。

## SPEC-ENTERPRISE-OIDC

既存の authorize / consent / token / userinfo を拡張する。
`prompt=login` / `select_account` / `max_age=0` はリクエスト作成後の認証を要求し、
正の `max_age` は認証時刻からの経過時間を検査する。同じ秒の古いログインも再認証には数えない。
無操作の同意ストアがないため `prompt=none` は `interaction_required` を返し、画面を開かない。
PKCE を指定する場合は S256 と43文字の challenge が必須。

同意の承認・拒否は Redis GETDEL で一回限り。承認時、code 交換時、userinfo 取得時に
現在の client 状態と企業認可を確認し、同じ地点で承認したセッションの失効
(`auth_epoch` / role / MFA 世代 / 端末) も再評価する。どちらか片方だけでは通さない。
承認は検証済み JWT の `exp` も見て、期限切れのログインセッションでは同意を成立させない。企業 connection の revision、組織 ID、メンバー role / joinedAt
を code と access token に束縛する。client・組織・ポリシー変更後の code を交換しない。
企業 token の期限は最長でも元の認証期間と設定上限まで。OIDC access token に refresh はない。

`auth_time` / `amr` は検証済みの事実だけから発行する。企業向けには `cr_user_id`、
`cr_auth_revision`、`cr_connection_revision`、`cr_project`、`cr_organization`、
`cr_organization_role` を追加する。Cr システム管理者 role は企業 role に変換しない。

## SPEC-ENTERPRISE-CONNECTION

`enterprise_connections` は project ごとに組織、専用 OIDC client、Cloudflare team domain、
application AUD、MFA 条件、認証期間、セッション上限を持つ。保存は revision による楽観ロック。
専用 client の redirect は `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` だけを許可する。
保存のたびに revision を変更し、既存企業セッションを失効させる。team / 組織変更では対応表を解除する。

企業接続が存在する project の旧 `auth.edge_assertion` 経路は、接続が無効でも拒否する。
無効化から旧方式への自動移行は行わない。管理 API に企業接続の削除操作はない。

## SPEC-ENTERPRISE-ASSERTION

企業ログインは認証済み `/ws/project` の `enterprise.login {assertion}` のみ。
projectKey は WS の認証から決まり、payload で変更できない。
Cr が固定 team domain の JWKS を用い RS256 の署名、issuer、application AUD、`type=app`、
UUID subject、必須 iat/exp、nbf を検証する。JWT 内の鍵 URL を取得しない。
鍵取得は10秒上限。期限切れ JWKS の障害時継続は企業経路で許可しない。

Access の署名付き `custom` から `amr`、`auth_time`、`cr_user_id`、`cr_auth_revision`、
`cr_connection_revision` を必須で受け取る。省略・切り詰め・型不正は拒否する。
MFA 必須時は `mfa` を要求する。認証時刻を Access JWT の発行時刻で代用しない。
Cloudflare subject の SHA-256 を明示的な Cr ユーザー対応に照合し、cr_user_id の一致も確認する。
メールや外部 role による自動作成・管理者昇格を行わない。

## SPEC-ENTERPRISE-SESSION

Redis の企業セッションは `ces_` +32 random bytes の opaque token。通常 user_access JWT、
project token、OIDC token と相互交換できない。通常 Cr の /auth、refresh、composite へ入れない。
期限は Access JWT の exp、元の認証時刻 + maxAuthenticationAge、発行時刻 + maxSessionSeconds の最短。
refresh は GETDEL で一度だけ回転し、元の期限を延長しない。

各 verify は現在の connection、project/client 有効性、subject 対応、組織所属、role、joinedAt、
MFA revision を確認する。組織退会・対応無効化・設定変更で次の操作を拒否する。

| 認証済み project command | payload | 結果 |
|---|---|---|
| enterprise.login | assertion | enterpriseToken, session |
| enterprise.verify | enterpriseToken | 公開 session 情報 |
| enterprise.refresh | enterpriseToken | 新 token、同じ絶対期限 |
| enterprise.logout | enterpriseToken | セッション削除 |
| enterprise.revoke_user | userId | 自 project の対応を無効化 |

`@ludiars/cernere-service-adapter` の `EnterpriseSessionClient` が上記を提供する。
`createEnterpriseAuthMiddleware` は API ごとに Cr を確認し、通常 token や認可取得不能時は拒否する。
`watch` は最初に verify、以降15秒ごとに再確認し、エラー・10秒の応答上限・絶対期限で
呼び出し側の WebSocket を閉じる callback を呼ぶ。従って無通信 WS の状態変更検出は通常15秒、
問い合わせ障害時は約25秒以内（イベントループ遅延を除く）。close 時に返却 disposer を呼ぶ。
重要操作の直前は `verify` を再度呼び、監視結果を認可 cache として使わない。

Cr 内の変更は上記で検知する。Cloudflare だけで失効させた JWT は暗号検証だけでは取消を検知できない。
退職処理では Cr の対応も無効化するか、信頼済みサーバーから `revoke_user` を通知する。
Cloudflare の未定義 webhook や SCIM を実装済みとは扱わない。

## SPEC-ENTERPRISE-ADMIN

`/enterprise` はシステム管理者専用。既存の組織・project・専用 client を選び、接続を保存する。
組織メンバーと Cloudflare subject の対応付け・再有効化・失効も扱う。
バックエンドでも管理者・接続中セッションを確認し、書き込みは既存の action proof で再本人確認する。
秘密の client secret は既存 OIDC 管理画面の一度だけの表示に限定する。
subject 平文、assertion、企業 token を監査ログへ保存しない。

## 導入と確認範囲

設定正本は [登録手順](../setup/cloudflare-enterprise-sso.md)、保存正本は
[データスキーマ](../data/schema/cloudflare-enterprise-sso.md)。新しい依存パッケージは追加しない。
本 PR は Cr と同リポジトリ内 SDK の実装。他サービスの checkout や稼働設定を自動変更しない。
回帰テスト定義を追加するが、このセッションではテスト・実接続・起動・migration を実行しない。

設計の外部根拠: [Cloudflare Generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)、
[Access application token と custom claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、
[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)。
