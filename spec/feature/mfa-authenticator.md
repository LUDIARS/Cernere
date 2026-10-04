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
| onsite/start | onsite 要求付き ticket の mfaToken (用途を問わない) | nonce・期限・kiosk 一覧 (SPEC-MFA-ONSITE) |

composite は `/api/auth/composite/mfa-send-code` / `mfa-verify` を利用する。
guest WS / project WS は `auth.mfa-send-code` / `auth.mfa-verify`。
コード用 payload は `{mfaToken, method, code?}`。composite の fingerprint は検証後の
既存 auth_session WS で渡す。projectKey は認証済み project WS の文脈を利用する。

## SPEC-MFA-ONSITE

2026-10-04 実装 (C1 + C2)。正本の設計は Ostiarius `spec/feature/onsite-mfa-factor.md`
(§0 の neco 決定 2026-10-01 を含む)。Actio タスク: `actio:cd51d109-b32b-4acb-b756-664825681573`。

Cr 単体では「その場に本人が居る」ことを証明できない。現地確認を要求するサービスへのログインに限り、
Ostiarius の kiosk の確認結果 (顔認証・パスキー) を追加要素 `onsite` として受け取る。
TOTP / メールを置き換えない。顔画像・テンプレート・スコアは送らず、受け取らない。

### 要求の決め方 (C2)

- `managed_projects.schema_definition.onsite_mfa` = `{ required, min_assurance: "high" | "medium", allowed_place_ids? }`。
  `service_scopes` / `identity_claims` と同じ管理者所有フィールドで、project client の
  `update_schema` では保存しない (`project/admin-owned-fields.ts`)。auto-sync で既存値を消さない。
- project 束縛のパスワードログイン (project WS の `auth.login` → composite) で `required=true` なら、
  利用者の MFA 設定有無にかかわらず challenge を返す。`mfaMethods` は `["onsite"]` だけで、
  この ticket は TOTP / メールでは満たせない。`allowed_place_ids` 未指定は全 active kiosk。
- `required=true` で定義が壊れている場合は要求を外さず 503 にする (fail closed)。

### kiosk 公開鍵レジストリ (C1)

kiosk (Ostiarius gateway) の Ed25519 公開鍵は Cr が持つ (`onsite_kiosks`、migration 057)。
Aedilis の gateway registry とは共有しない。列は lanId (一意キー) / placeId / publicKeyPem (SPKI PEM) /
lanUrl (施設 LAN 上の Ostiarius の https URL) / label / status (active | revoked) / 作成・更新・失効時刻。

| 操作 | 認可 | 結果 |
|---|---|---|
| `POST /api/admin/onsite-kiosks` `{ lanId, placeId, publicKeyPem, lanUrl, label? }` | admin の user access token | upsert。revoked の lanId は 409 (新しい lanId を要求) |
| `GET /api/admin/onsite-kiosks` | 同上 | 一覧 |
| `POST /api/admin/onsite-kiosks/:lanId/revoke` | 同上 | 失効 (冪等、行は削除しない) |

Ostiarius からの自己登録はしない。運用者が Ostiarius の `GET /gateway-public-key` の値を登録する。
管理画面は `/onsite-kiosks` (admin のみ)。

### challenge と受け渡し

challenge は SPEC-MFA-CHALLENGE の ticket (`mfaToken`) をそのまま使う。ticket に onsite 要求と
発行時の `mfa_revision` を記録する。QR は使わず、利用者端末と kiosk の LAN 内通信で nonce を渡す。

1. 端末 → Cr `POST /api/auth/mfa/onsite/start` `{ mfaToken }` →
   `200 { nonce, expiresAt, kiosks: [{ lanId, placeId, lanUrl, label }] }`。
   nonce は 32 byte 乱数 base64url、ticket に束縛、期限は ticket と同じ、一回消費。
   再度 start すると前の nonce は無効になる。kiosks は active かつ許可施設のみ (無ければ 503)。
2. 端末 → kiosk の LAN URL `POST /api/mfa/onsite/sessions` `{ nonce }` (Ostiarius 側、契約 E)。
   端末は nonce 以外を送らない。
3. Ostiarius → Cr `POST /api/mfa/onsite/attestations` `{ attestation }`。
   Bearer は Ostiarius の project client credentials から得た project token。
   呼出元 project の `service_scopes` に `onsite-mfa:submit` が宣言されていなければ 403、
   token 無し / 不正 / rotate 済みは 401。200 `{ accepted: true }`、4xx `{ error: <code> }`。
4. 端末 → 既存の MFA verify に `method: "onsite"` (code は空)。REST / guest WS / composite /
   project WS の 3 経路で同じ `verifyMfaChallenge` を通る。未充足なら 409 `onsite_pending`
   (端末は約 2 秒間隔でポーリングする)。充足済みなら既存と同じ一回消費でセッション / authCode を発行する。
   ポーリングは推測可能な秘密を持たないので、コード用の試行回数 (5 回) ではなく ticket あたり 300 回で縛る。

attestation を受理しても ticket は消費しない。ticket に「onsite 充足 (method, assurance, placeId, lanId)」を
記録するだけで、verify の一回消費がその記録ごと ticket を消す。

### attestation の検証 (Os spec §4.2 の順)

形式: `base64url(JSON payload) + "." + base64url(Ed25519 署名)`。payload は
`{ sub, placeId, lanId, nonce, issuedAt, method, assurance, purpose }` (purpose 欠落 = attendance)。

1. 署名: 登録済み・active の kiosk 公開鍵で検証 (`unknown_kiosk` / `revoked_kiosk` / `invalid_signature`)。
2. 用途: `purpose == "mfa"` (`purpose_mismatch`)。
3. 束縛: nonce が有効な onsite challenge に一致し (`nonce_unknown` / `nonce_used`)、`sub` が challenge の
   userId と一致する (`subject_mismatch`)。
4. 鮮度: `issuedAt` が 120 秒以内 (`stale`)。nonce は受理時に原子的に used へ遷移する。
5. 確度: 要求値以上 (`assurance_insufficient`)。`staff_override` (`manual`)・`session` / `password` (`low`) は
   常に不受理。kiosk 経由の `passkey` (`medium`) は要求値が `medium` のとき受理する。
6. 場所: `placeId` が kiosk の登録施設と一致し、`allowed_place_ids` 指定時はその中にある (`place_not_allowed`)。
7. 設定状態: challenge 発行後に `mfa_revision` が変わっていない (`mfa_revision_changed`)。

その他の不正な形式は `invalid_format`。

### 範囲外

- passkey / Google / GitHub / Cloudflare edge assertion など、パスワード以外の project 束縛ログイン経路への
  onsite 自動要求は本実装に含めない (既存の MFA もパスワード経路だけが対象)。
- 個別の操作 (action-policy) 単位での現地確認要求は持たない。要求はサービス設定だけで決まる。

## 保存と反映

`migrations/047_mfa_authenticator.sql` は `users.totp_last_step` と `users.mfa_revision` を追加する。
実行前に migration を適用する。既存鍵を平文へ戻す移行や、既存 MFA の自動無効化は行わない。
`CERNERE_SECRET_KEY` と、メール利用時の SES / SMTP 設定は既存の秘密管理から投入する。
Google / GitHub / passkey は既存の別認証経路を維持する。この MFA の適用対象はパスワード経路。
Cloudflare 向け `amr` / `auth_time` の発行をこの変更で完了扱いしない。

`migrations/057_onsite_kiosks.sql` は kiosk 公開鍵レジストリ `onsite_kiosks` を追加する。
onsite で完了したログインの `amr` は `["pwd", "mfa"]`。

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
