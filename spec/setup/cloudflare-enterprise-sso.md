# Cloudflare 企業認証の登録手順

実装正本: [Cloudflare 企業認証](../feature/cloudflare-enterprise-sso.md)。
登録タスク: Memoria #2309（Google OIDC）、#2310（Cloudflare と Cr の接続）。
Google 登録は [既存手順](google-oidc.md)。Google の利用は Cloudflare 接続実装の前提にしない。

## Cr の配置・既存機能

PR 反映時に通常の migration ランナーで `048_enterprise_cloudflare.sql` を適用する。
既存 MFA の `047_mfa_authenticator.sql` が前提。データを削除する手順はない。
公開 HTTPS issuer / frontend URL、OIDC 署名鍵ストア、MFA の secret / mail 設定は
既存 [OIDC](oidc-provider.md) と [MFA](../feature/mfa-authenticator.md) の手順を使う。
サービスのポート・起動場所は Excubitor catalog が正本。ここに固定 port を転記しない。
Cr の初回ログインを同じ Cloudflare Access / Cr OIDC で囲むと循環するため、認証入口の公開経路を分ける。

## 登録作業

1. Cr で対象組織、メンバー、managed project を登録する。管理者は操作承認用パスキーを登録する。
2. Cloudflare の Team domain、対象 application AUD を取得する。
3. Cr の OIDC 管理画面でこの接続専用の client を作る。redirect URI は
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` の1件。
   scopes は openid / email / profile。secret は正式な秘密管理へ保存する。
4. Cloudflare Generic OIDC に client ID / secret と Cr の discovery が示す authorization / token / JWKS URL を登録する。
   PKCE を有効にし、対象アプリが利用する IdP をこの Cr の登録に限定する。
   他の IdP やメール PIN で企業用 claim を代替しない。
5. custom claim の転送名を **amr, auth_time, cr_user_id, cr_auth_revision, cr_connection_revision** とする。
   amr は文字列の配列、auth_time / cr_auth_revision は数値を保つ。文字列への変換は行わない。
   MFA 必須の運用は Cloudflare の認証方法条件にも mfa を指定する。
6. Cr `/enterprise` で組織、project、専用 client、team、AUD、期間を設定して保存する。
   設定が揃った時点で有効化する。保存のたびに既存 Cloudflare ログインも再認証が必要になる。
7. Cloudflare で Cr 経由のログインを行い、Cloudflare のユーザー subject UUID を確認する。
   Cr 管理画面で対応する組織メンバーへ割り当てる。OIDC 同意では組織所属を確認するが、
   Access の subject 対応は初回ログイン後に登録できる。割り当てるまでは企業アプリのセッションを発行しない。

custom claims は Access のサイズ制約により欠落し得るため、転送する項目を必要分に絞る。
欠落時は Cr が拒否する。登録時に実際の署名付き claim の型と存在を確認する。
外部仕様: [Generic OIDC 登録](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)、
[Access custom claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、
[MFA 条件](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)。

## サービスへの組み込み契約

サービス側の信頼済み project WS transport を渡す。ブラウザから project credential を扱わない。
`EnterpriseSessionClient` と middleware は本 PR で実装済み。新たに採用するアプリは以下の公開 API を使う。

```typescript
import { EnterpriseSessionClient, createEnterpriseAuthMiddleware } from "@ludiars/cernere-service-adapter";

const enterprise = new EnterpriseSessionClient(projectKey,
  (module, action, payload) => projectWs.sendCommand(module, action, payload));

// Access を通ったリクエストの cf-access-jwt-assertion をサーバーから渡す。
const login = await enterprise.login(assertion);
// token はサービスのセッション保護方針に従って保持し、通常 Cr token に交換しない。
app.use("/enterprise-api/*", createEnterpriseAuthMiddleware(enterprise));

// WebSocket は接続受理前に verify。接続後の失効監視も保持する。
await enterprise.verify(token);
const lifecycle = new AbortController();
socket.on("close", () => lifecycle.abort());
await enterprise.watch(token, () => socket.close(4001, "authorization changed"), lifecycle.signal);
// メッセージの重要操作直前にも await enterprise.verify(token)。
```

watch 準備中の下流切断も AbortSignal で中止する。AbortSignal を渡さない場合は返却 disposer を close 時に呼ぶ。
Cr が不通なら利用を許可しない。ローカル user ID / role ヘッダーへの fallback は設けない。
アプリ独自のリソース認可には `organizationId / organizationRole` を使い、Cr のシステム role を使わない。

## 退職・障害時

Cr のユーザー対応を失効させる。組織からの削除も企業セッションを無効化する。
Cloudflare 側の取消も実施する。Cloudflare だけの取消を Cr に同期する場合は、信頼済み
サービスから `enterprise.revokeUser(userId)` を呼ぶ。管理者の手動操作も利用できる。
接続全体を止める場合は Cr の接続を無効化する。旧 edge 認証へ自動で戻らない。

## 動作確認

このセッションでは未実施。実施する回にユーザーの明示許可を得て Concordia testing claim を行い、
Excubitor から Cr 本体フォルダを起動する。成功系、MFA 未完了、wrong AUD、custom 欠落、
期限・refresh、退会・role 変更・対応失効、WS 切断、Cr / JWKS 障害、通常 token の拒否を確認し、
Revisor の TestWorkflow スレッドへ記録する。検証済み token や秘密値を投稿しない。
