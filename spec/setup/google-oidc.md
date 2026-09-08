# Google OIDC の設定

Google を Cr の本人認証元として使うための設定手順。
今回の作業では実環境の設定・再起動・Google へのログイン確認を行っていない。

1. Google Cloud で Web application 用 OAuth client を用意し、同意画面と利用対象を設定する。
2. 承認済み redirect URI に Cr バックエンドの公開 callback URL を正確に登録する。
   パスは `/auth/google/callback`。公開ホストは配置先の設定を使い、ローカルの固定 port を流用しない。
3. client ID / secret / redirect URI を Infisical または既存 Excubitor の env 注入で渡す。
   secret をソース、資料、Discord に貼り付けない。
4. Cr フロントのログイン画面から「Google で続ける」を選ぶ。
   `/auth/google/login` を手作業で直開きする代わりに、タブの照合を準備する
   `/login/google/start` を経由する。

Google に登録する URI と Cr の設定値は完全一致が必要。
[Google の client / redirect URI 設定](https://developers.google.com/identity/openid-connect/openid-connect)

| キー | 用途 |
|---|---|
| GOOGLE_CLIENT_ID | Google に登録した Web application client ID |
| GOOGLE_CLIENT_SECRET | 上記 client の secret（秘密管理から注入） |
| GOOGLE_REDIRECT_URI | Cr バックエンドの公開 `/auth/google/callback`。localhost 以外は HTTPS |
| GOOGLE_OIDC_HOSTED_DOMAINS | 任意。Google Workspace の許可ドメインをカンマ区切りで指定 |
| FRONTEND_URL | ブラウザが実際に開く Cr フロントの公開 URL |

HOSTED_DOMAINS を空にすると、特定の Google Workspace への限定を行わない。
設定すると `hd` のない個人 Google アカウント、別ドメインのアカウントを拒否する。
例えば `example.com,example.org`。ワイルドカードは使えない。
この制限は Cr インスタンスの Google ログインと Google link 全体に適用され、
企業ごとのアプリ認可や Google 以外の認証方法への制限の代用にはならない。

通常ログインを開始したフロントと FRONTEND_URL は同じ origin にする。
タブの sessionStorage を使うため、途中で別ホストや別タブへ切り替えるとログインをやり直す。
Google と通信できない、client 設定が不正、鍵や ID token が検証できない場合は明示的に失敗する。

Cloudflare Access を使う場合は Cr を Generic OIDC の認証元として登録する。
Cr の discovery、署名鍵、OIDC client / redirect URI 登録は [既存の OIDC 設定](oidc-provider.md) に従う。
MFA の扱いと現行の制限は [Google OIDC 仕様](../feature/google-oidc-identity-source.md) を参照。
Cr の初回認証入口を、同じ Cr 認証が必要な Access ポリシーの内側へ置いて認証ループを作らない。

反映後の確認は明示的なテスト指示を受けてから行う。
起動・再起動は Excubitor 経由・プロジェクト本体のみで、Concordia の testing claim / release を使う。
