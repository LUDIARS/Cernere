# Google OIDC を Cr の認証元にする

2026-09-08。Google を本人認証に使い、Cr のアカウントとアプリ認可へ接続する。
既存の Google ログインボタンと Google client 設定を利用する。

```text
Cloudflare Access → Cr の OIDC 同意画面 → Google で本人認証
  → Cr が Google ID token を検証してログインを完了
  → Cr の同意画面へ戻る → 利用者が承認 → Cloudflare へ Cr の認証結果を返す
```

Cr 単独への Google ログイン、埋め込みログイン、本人のプロフィールからの Google 連携も対応する。
Cloudflare 自体の設定変更は含まない。Google の ID token をそのまま Cloudflare に転送せず、
Cr は自分の user ID、署名鍵、OIDC client に対応した認証結果を発行する。

## SPEC-GOOGLE-OIDC-REQUEST: 認証要求の束縛

Google 向け Authorization Code フローは `openid email profile` だけを要求する。
CSRF state の cookie 一致に加え、nonce と PKCE S256 を要求する。
Redis `googleoidc:<stateのSHA-256>` に nonce、code verifier、client ID、redirect URI と
任意の Cr OIDC request ID / ブラウザ state を 600 秒保存する。
callback では `GETDEL` で一度だけ消費し、開始後の設定変更も拒否する。
旧フロー・期限切れ・使用済み request は互換受理せず、ログインを最初からやり直す。

通常ログインのブラウザ入口は `/login/google/start`。
開始したタブの sessionStorage に乱数 state を保存し、バックエンド `/auth/google/login` へ進む。
Cr OIDC の同意から始めた場合は request_id を引き継ぐ。任意の外部戻り先を受け取らない。
Google アカウントの link は既存の Bearer + action proof + Redis grant を使用し、
通常ログインへのフォールバックを行わない。埋め込み先は既存 composite 許可リストで確認する。

## SPEC-GOOGLE-OIDC-VERIFICATION: Google ID token の検証

Google との token 交換で `id_token` を必須とする。userinfo だけではログインを成立させない。
既存の JWT ライブラリで RS256 の署名を検証する。Google 固定の公開鍵 URL のみを使い、
token 内の URL にはアクセスしない。鍵の更新は Google の Cache-Control に従い、
最長1時間まで cache する。取得には10秒の timeout、更新には同時要求の集約と1分の間隔を設ける。
検証不能時に古い鍵や未検証 token へ切り替えない。

検査項目は issuer、client audience、azp（存在時。複数 audience では必須）、
必須の整数 iat / exp、期限、nonce、非空で安定した sub、email_verified=true と email。
clock skew は60秒。Google Workspace に限定する設定時は署名付き hd を照合する。
名前・画像がない token も本人特定には使える。表示名を補い、既存の本人設定名は自動上書きしない。

Google sub を既存 `users.google_id` に対応付ける。メール一致だけで別の Cr アカウントへ
自動接続しない。既存 email と衝突した場合は、既存アカウントでログインして Google を連携する。
新規ユーザーの内部 login は `google_<Cr user UUID>` とし、メールのローカル部へ依存しない。
Cr の role は既存の DB / 初回登録規則から決まり、Google の claim で管理者権限を付与しない。

Google API の offline access や毎回の consent を要求しない。
ログイン用の Google access / refresh token は新たに保存しない。
過去に保存済みの暗号化 token は削除・移行しない。API 利用の権限取得は別の連携として扱う。
新規 dependency / SQL migration は追加しない。

Google が示す ID token 検証項目と sub / hd の扱いに基づく。
[Google: ID token の検証](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

## SPEC-GOOGLE-OIDC-HANDOFF: Cr のログインを完了する

Google の検証後に共通 `issueAuthCodeForUserId` で Cr の一回限り・60秒の code を発行する。
通常フローは `/login/google/callback` へ返す。`/auth/*` の backend proxy と衝突しないパスを使う。
callback は開始したタブの state と一致するときだけ code を交換し、URL から code を取り除く。
React StrictMode の effect 再実行でも同じ交換 Promise を使い、二重交換しない。
完了時は開始したタブが state と対で保存した戻り先、保存済みの Cr OIDC request_id を持つ同意画面、
または Cr のトップへ戻る。`/login?redirect=/x` の戻り先は Google 経路でも失わない。
タブ保存の戻り先はサーバへ渡さず、URL 由来の値をそのまま採用しない。
戻り先は同一 origin のローカルパスに限定する。

埋め込みフローは既存 `/composite/callback` に code を渡す。
link は本人の既存セッションを保持してプロフィール連携を完了する。
Google 処理中に HTTP が切断された場合、終了済み response へ書き込まない。
失敗画面には token / Google 応答 / DB の内部情報を出さない。

## Cloudflare / MFA の範囲

この変更で Google を Cr の本人認証元として利用できるコードが揃う。
Google ログインの成功だけで企業 MFA 成功、Workspace 所属、端末信頼を推測しない。
Google の `amr` / `auth_time` を要求・継承する機能は本変更に含めていない。
Cr から Cloudflare へ出す企業認証の強度、実認証時刻、セッション期限・失効の継承は別途必要。
既存 Cr OIDC の auth_time は同意承認時刻であり、Google で本人認証した時刻ではない。

Google client の設定と Cloudflare の OIDC client 登録が済めば、本人認証の経路として接続できる。
企業 MFA 完了を証明する構成としては上記の追加実装が必要。
Google のクライアント登録・認可コードフローの仕様は
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) を参照。

## 実装と確認範囲

server: `auth/google-{oidc-client,oidc-request,id-token,signing-keys}.ts`、
`auth/oauth-link.ts`、`http/oauth-handler.ts`。frontend: GoogleSignInPage、OAuthCallbackPage、
google-browser-state と既存 CompositeLoginPage / App の接続。

server / frontend の `tsc --noEmit` と差分を静的確認する。
単体・統合・起動テストはユーザー方針により追加・実行しない。
既存 PR #1516 の用途分離とは別の変更として提出する。

関連: [設定手順](../setup/google-oidc.md)、[問題記録](../plan/problem_logs/2026-09-08-google-oidc-login-boundary.md)、
[Cr OIDC Provider](oidc-provider.md)。
