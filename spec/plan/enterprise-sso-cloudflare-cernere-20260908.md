# Cloudflare Zero Trust と Cr のログイン統合案

2026-09-08 / Status: 提案。使用する製品は Cloudflare と Cr。企業設定変更・デプロイは未実施。

## 提案

**Cr のアカウントを共通の本人認証に使い、Cloudflare Access が企業の入場条件を判定する。**
Cloudflare に Cr を Generic OIDC の認証元として登録する構成を推奨する。
Cr のユーザー台帳とログインを再利用できるため、Cloudflare 用の別パスワードは作らずに済む。
Cloudflare は Generic OIDC 接続に対応している。
[Cloudflare Generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)

```text
社員が業務アプリを開く
  → Cloudflare Access が Cr へ OIDC ログインを依頼
  → Cr で本人認証（有効な認証があれば再利用）
  → Cr が署名付きの本人認証結果を Cloudflare へ返す
  → Cloudflare が所属・端末・MFA 等の入場条件を判定
  → 業務アプリへ到達
  → Cr は企業・アプリの文脈に応じて業務データの権限を判定
```

これは今回利用する Cloudflare と Cr を接続する提案であり、外部 IdP の追加導入は前提にしない。

## 管理の分担

| 担当 | 管理するもの |
|---|---|
| Cr の認証 | 本人アカウント、ログイン、認証方法と実際の認証時刻、OIDC による本人情報の提供 |
| Cloudflare Zero Trust / Access | 企業のアプリへの入場条件、端末・ネットワーク条件、要求する MFA、Access セッション |
| Cr の認可 | 組織・アプリの役割、プロフィール・データの利用権限、企業用のアプリセッション |

企業向けのアクセス制御と本人認証は連携するが、同一の機能ではない。
利用者のログイン体験をまとめても、Cloudflare の入場許可が Cr の全管理機能や全データの許可にはならない。
今回修正したサービス別プロフィール grant は引き続き必要になる。

「Cr とは別」の範囲は、Cloudflare 連携設定・信頼先・企業用セッションの独立管理で満たせる。
最初は Cr 内の独立した連携モジュールとし、別プロセスや別ユーザー台帳を増やさない構成を提案する。

## MFA を二重に要求しないための方針

Cr で実際に完了した認証方法を OIDC の `amr` 等で証明し、Cloudflare の要求を満たす間は
追加の MFA を要求しない設計を目標にする。Cloudflare は Generic OIDC に対する
IdP-based MFA 条件と、Cloudflare 自身が追加要素を確認する Independent MFA の両方を備える。
[Cloudflare MFA 仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)

実施場所は企業ポリシーで一方に寄せる。

- Cr が必要な強度の認証を完了し、その証拠を出せる場合は Cloudflare が結果を利用する。
- Cr の認証だけでは要件を満たさない構成では Cloudflare の Independent MFA を使う。
  その完了結果を企業用 Cr セッションに引き継ぎ、アプリ内で Cr 独自 MFA を繰り返さない。

Cr にログインできたことや passkey が登録されていることだけで `mfa` を付けない。
実際の検証結果、User Verification、企業の要求強度に基づく対応付けが必要。
認証が古い・不足する場合は企業の要求に従い再認証する。
Cloudflare で MFA が完了しても通常の個人 Cr セッションを一律に昇格させない。

## 既存実装を利用できる部分

- `server/src/oidc/provider.ts`、`auth/oidc-keys.ts`:
  Cr が IdP として認可コードを発行し、RS256 の id_token と JWKS を提供する。
  [既存 OIDC 仕様](../feature/oidc-provider.md) に Cloudflare 接続が想定されている。
- `server/src/auth/edge-assertion.ts`、`project/edge-bindings.ts`:
  Cloudflare からアプリへ渡った署名付き JWT を Cr が検証する土台がある。
  Cloudflare で実施した追加 MFA や入場結果を企業用セッションへ戻す場合に利用する。
  これは最初の Cr ログインを再度開始する経路ではない。

**現状のコードだけで MFA・失効まで統合済みとは扱わない。**
OIDC に `amr` がなく、`auth_time` も現在は本人認証時刻ではなく同意承認時刻から作られる。
edge assertion は外部の強度や期限を継承せず、通常の長期 refresh を発行する経路につながる。
Cr 独自 TOTP / email MFA の完了器も未配線で、今回の修正は不正な成功を拒否するもの。

## 実装タスク案

1. **認証結果の記録**: user session に実認証時刻・検証済み認証方法・企業文脈を保持し、
   OIDC 認可コードと id_token に正しく継承する。refresh や同意の承認で認証時刻を更新しない。
   必要な `max_age` / 再認証要求を満たさない場合は再認証へ戻す。
2. **Cloudflare 接続設定**: Cr の OIDC client と Cloudflare application を企業単位で対応付ける。
   redirect URI・issuer・audience を固定し、scope と渡す本人情報を最小限にする。
   Cr 側のユーザーと企業への所属を確認し、メールアドレス一致だけで権限を付けない。
3. **Access 結果の検証**: 入場結果を取り込む場合は `Cf-Access-Jwt-Assertion` を
   Cr が公開鍵で検証し、登録企業の issuer、対象アプリの AUD、必須の有効期限と認証情報を確認する。
   Cloudflare からのヘッダという自己申告だけで許可しない。
   [Cloudflare JWT 検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
4. **企業セッションと失効**: 対象組織・アプリ・認証方法・外部期限を固定する。
   通常の 30 日 refresh で Access の期限を延ばさない。退職・権限削除・連携無効化を
   アプリセッションと WS 継続接続へ反映し、反映の最大遅延を設計・運用条件として決める。
5. **ループと迂回の防止**: Cr の初回ログイン・OIDC 公開入口を、同じ Cr ログインが必要な
   Cloudflare ポリシーの内側へ閉じ込めない。認証専用ホスト／入口を設け、Cr 自身の認証、
   OIDC client 検査、rate limit で守る。業務 API、管理 UI、origin 直通は別に保護する。
   一度 Access を通った後の既存 WS や別 API でも企業条件を迂回できないようにする。
6. **連携 UI**: 対象企業・対象アプリ、Cloudflare team / AUD、OIDC client、
   必須 MFA、認証期限、所属・役割の対応を管理する。
   外部の所属から Cr 全体の system admin を自動付与しない。

Cloudflare の service token は機械処理用で、社員のログインや MFA の代用にしない。
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

最初は1つの企業用アプリで、本人認証・MFA の証拠・企業セッション・失効までをまとめて導入する。
この資料は構成の提案であり、Cloudflare テナントの現在設定・契約・実際の claim 内容は未確認。
今回の3件のセキュリティ修正には、Cloudflare 設定変更や企業 SSO の有効化を含めない。
