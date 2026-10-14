# 検証: パスキーのみ認証の実装に対する攻撃耐性 (Fable)

2026-10-14。依頼: [tasks/2026-10-14-passkey-only-attack-verification-request.md](../tasks/2026-10-14-passkey-only-attack-verification-request.md)。
対象は `feat/passkey-only-auth` (main..HEAD = 0bea244..d60f276) の**コード**。設計書 [2026-10-14-passkey-only-authentication.md](2026-10-14-passkey-only-authentication.md) は照合先として使い、設計の是非そのものは再論しない。
実装は変更していない。テスト・起動はしていない。

読んだコード: `server/src/auth/{device-pairing,passkey-candidates,recovery-code,recovery-request,retired-login,admin-bootstrap,webauthn-policy,action-proof,action-policy,jwt,user-session-state,registration-grant,mfa-challenge,edge-assertion,auth-code}.ts`、`server/src/http/{passkey-handler,recovery-code-handler,auth-handler,oauth-handler,composite-handler,bearer-user,action-auth-handler,passkey-recovery-handler}.ts`、`server/src/ws/{guest,handler,session-registry,project-dispatch,auth}.ts`、`server/src/notify/*.ts`、`server/src/commands.ts`、`migrations/065〜067`、`server/src/db/schema.ts`。

neco の前提「Cr はサービス共通認証であり、他人の公開データにアクセスする権限も持つ」を踏まえ、§5 では「誰でも即時に作れる一般アカウント 1 つ」で何ができるかを経路つきで挙げる。

---

## 0. 指摘一覧 (重大度順)

| # | 重大度 | 成立 | 項目 | 要旨 | 場所 |
|---|---|---|---|---|---|
| F1 | **高** | 成立 | 5 | WS relay が任意ユーザー・任意セッションへ届く (同一ユーザー限定が未実装) | `ws/handler.ts:218`, `ws/session-registry.ts relay()` |
| F2 | **高** | 成立 | 5 | 一般ユーザーが全ユーザーのメール・role を検索・取得できる | `commands.ts user.search / user.get` |
| F3 | **高** | 成立 | 3, 6 | 回復確定・運用者回復が生きている WS セッション (Redis 7 日) を失効させない。盗難端末の WS が回復後も残る | `recovery-request.ts confirmRecovery`, `registration-grant.ts completeRecovery`, `ws/auth.ts`, `commands.ts dispatch` |
| F4 | 中 | 成立 | 3 | 運用者による回復要求の凍結が未実装 (`frozen_at` を書く経路が無い)。運用者が盗難 QR の要求を止める手段は「完全な運用者回復」だけ | `recovery-request.ts:260`, `auth/recovery-command.ts` |
| F5 | 中 | 成立 | 5 | 組織 ID を知れば非メンバーでも `member.list` (メール含む)・`organization.get`・`presence`・`org_project.list` が読める | `commands.ts memberCmd / organizationCmd / orgProjectCmd` |
| F6 | 中 | 成立 | 4 | 通知の出来事の記録漏れ: プロフィールからのパスキー追加・削除、全端末ログアウトが記録されない。`security_events` の読み出し API が無く `/security` 画面は作れない | `http/passkey-handler.ts registerFinish / deletePasskey`, `auth/device-command.ts` |
| F7 | 中 | 成立 | 2 | 承認は「PC に表示された番号を目で比べて承認ボタン」。QR を盗み見られた被害者のスマホには番号が出ない (エラーになる) ため、比べずに承認できてしまう。番号を PC 側で入力させる方式にすべき | `device-pairing.ts getPairingStatus / approvePairing`, `http/passkey-handler.ts pairingStatus` |
| F8 | 中 | 成立 | 1, 3 | `composite-signup-finish` (REST) は composite 許可 origin からの WebAuthn 応答も受理する。設計の「新規作成は Cr origin の popup でだけ」は WebAuthn の origin 検証では担保されていない | `auth/webauthn-policy.ts ORIGINS`, `http/passkey-handler.ts compositeSignupFinish` |
| F9 | 中 | 成立 | 3 | 正規の QR 保持者は、盗難者の要求が保留中だと同じ 401 を返され、理由も分からず自己回復できない (24h 後に盗難者が勝つ)。旧キーが無い本人に取消手段が無い | `recovery-request.ts beginRecoveryWithCode (hasOpenRequest)` |
| F10 | 低 | 成立 | 4 | Discord 本文の escape が URL・時刻にも掛かり `https\://` になる。リンクの自動展開が壊れる可能性 | `notify/discord-alert-sender.ts escapeDiscord / sendDiscordDm` |
| F11 | 低 | 成立 | 2 | QR を読んだ端末が付けた `nickname` (64 文字) がそのまま所有者のパスキー一覧に出る | `device-pairing.ts finishPairingRegistration` |
| F12 | 低 | 成立 | 5 | `project_definition.list/get` を一般ユーザーが読める (data_sharing / profile_access / pluginRepository の偵察) | `commands.ts projectDefCmd` |
| F13 | 低 | 成立 | 5, 6 | signup に全体 burst 上限が無い (IP ごと 5/10 分のみ)。分散 IP で無制限に作れる | `http/passkey-handler.ts signupBegin` |
| F14 | 低 | 成立 | 6 | `register-finish` が GET→DEL (GETDEL でない)、`register-begin` の challenge キーがユーザー単位で並行開始が後勝ち | `http/passkey-handler.ts registerBegin / registerFinish` |
| F15 | 低 | 成立 | 3 | `recovery-code-finish` の並行実行で unique index 違反が 500 になる (401 に揃っていない) | `recovery-request.ts finishRecoveryWithCode` |
| F16 | 低 | 成立 | 1 | guest WS の既定エラー文が「Use 'register' or 'login'」のまま | `ws/guest.ts` |
| N1 | — | 不成立 | 1 | password / OAuth ログイン / guest / composite / project WS の `login`・`register`・`passkey-signup-*` は全経路で 410。OAuth callback は link grant が無いと成功しない | §1 |
| N2 | — | 不成立 | 1 | MFA verify (REST / guest / composite / project WS) は残るが、ログイン用 ticket の発行元が無い (purpose 束縛) | §1.3 |
| N3 | — | 不成立 | 2 | 候補が承認無しで有効化される経路、proof の resource 束縛の抜け、epoch・期限・並行の競合は見つからなかった | §2 |
| N4 | — | 不成立 | 3 | 候補キーで login / action proof は通らない。24h 待機の前倒し・admin 除外の抜けは無い | §3 |
| N5 | — | 不成立 | 4 | 宛先の乗っ取り・偽装、確認番号の総当たり、通知文への注入は成立しない | §4 |

**「他人のデータ」の観点で最も重いのは F1・F2・F5**。いずれも本ブランチの新規コードではなく既存の WS モジュールだが、「誰でも即時に一般アカウントを作れる」ことで匿名者に開放された。パスキー化そのものの実装 (pairing・リカバリー QR・通知) は、束縛・競合・失効の面では堅く、成立した攻撃はいずれも「周辺の未実装・既存の緩さ」に起因する。

---

## 1. 認証の迂回

### 1.1 廃止した入口 (不成立 N1)

| 入口 | 実装 | 根拠 |
|---|---|---|
| `POST /api/auth/register` | 410 `login_method_retired` | `auth-handler.ts handleAuthRoute case "register"` |
| `POST /api/auth/login` (人間) | `grant_type` が `client_credentials` / `project_credentials` 以外は 410 | `auth-handler.ts clientCredentialLogin` |
| composite REST `login` / `register` | 410 | `composite-handler.ts handleCompositeRoute` |
| project WS `auth.login` / `auth.register` | `retiredLoginError()` を throw | `composite-handler.ts executeCompositeAction` ← `project-dispatch.ts` |
| project WS `auth.passkey-signup-begin/finish` | 410 `signup_moved_to_popup` | `passkey-handler.ts executePasskeyCompositeAction` |
| guest WS `register` / `login` | `retiredLoginError()` | `ws/guest.ts` |
| `GET /auth/{github,google,discord}/login` | `LOGIN_METHOD_RETIRED_MESSAGE` を throw | `oauth-handler.ts handleOAuthRoute` |
| OAuth callback | `resolveLinkTarget` が Redis の link grant を解決できなければ常に throw。grant は Bearer + action proof (`oauth.link`) で作られる。callback は `users` を update するだけで token を発行しない | `oauth-handler.ts githubCallback / googleCallback / discordCallback` |

### 1.2 残っている非パスキー経路 (設計どおりだが明記)

- **edge assertion** (`project-dispatch.ts edge_assertion` → `edge-assertion.ts authenticateEdgeAssertion`): project WS (サービス資格情報) + admin が登録した `edge_idp` binding + Cloudflare Access JWT の検証で、ユーザーを **JIT 作成** (`provisionUser`, role は `binding.defaultRole`) し authCode を返す。設計 §10 の企業限定例外。注意点: edge で作られたユーザーはパスキー無しで存在し、`action-auth begin` が「passkey 必須」で落ちるため、リカバリー QR 発行・通知先設定など proof を要する操作が一切できない。binding を持つ組織では「最初にパスキーを登録させる」導線が要る。
- **Device Credential** (`device-handler.ts`): root passkey に束縛され、`assertUserSessionCurrent` で root passkey の失効・epoch を毎回検証する。迂回ではない。
- **MFA verify** (`mfa-handler.ts` / `guest.ts` / `composite-handler.ts`): `issueMfaLogin` でセッションを発行できるが、ticket は `purpose` 束縛 (`mfa-records.ts:46`) で、ログイン用 purpose (`rest` / `guest` / `composite`) の ticket を発行する `beginMfaChallenge` 呼び出しは `mfa-settings.ts` (purpose `manage`) だけ。**不成立 (N2)**。ただし死んだコードが 3 入口に残っており、将来 ticket 発行元を足すと単要素ログインが復活する。削除を推奨。

### 1.3 composite 許可 origin での signup (F8, 中)

- **前提**: 攻撃者が composite 許可 origin (= 埋め込み先サービス) のページでスクリプトを実行できる (サービス侵害 or XSS)。
- **手順**: そのページから直接 `POST /api/auth/passkey/signup-begin` → `navigator.credentials.create()` → `POST /api/auth/passkey/composite-signup-finish`。`finalizePasskeySignup` の `expectedOrigin: ORIGINS` は `mergeWebauthnOrigins(webauthnOrigins, compositeAllowedOrigins)` なので、Cr origin でない応答も検証を通る。
- **影響**: 「オンボーディングとリカバリー QR を埋め込み先に通さない」(設計 §2) が WebAuthn 層では担保されない。利用者を Cr の `/onboarding` を経ずに作れ、リカバリー QR 無し・通知先無しのアカウントを量産できる。また第三者サービスの画面でパスキー作成 UI を出す「なりすまし signup」が可能 (利用者は Cr のアカウントを作ったと気づかない)。
- **修正案**: signup 系 (`signup-finish` / `composite-signup-finish`) の `expectedOrigin` を `config.webauthnOrigins` (Cr origin) に限定する。login 系は現状どおり合流で良い。CORS 設定で既に REST が埋め込み origin から叩けないなら実害は小さいが、WebAuthn 層で閉じる方が明示的。

---

## 2. 端末追加 (pairing)

### 2.1 確かめた点 (不成立 N3)

| 観点 | 結果 | 根拠 |
|---|---|---|
| 承認無しでの有効化 | 無い。`passkeys` へ入れるのは `promotePasskeyCandidate` だけで、呼び出しは `approvePairing` (proof 済み) と `confirmRecovery` (24h 後) のみ | `passkey-candidates.ts` |
| 候補キーでのログイン・proof | 不可。`verifyPasskeyAssertion` と `action-auth-handler.ts finish` は `passkeys` しか引かない | `passkey-handler.ts:583`, `action-auth-handler.ts` |
| proof の resource 束縛 | `pairingId:candidateId`。`pairingApprove` は DB から candidateId を引き直して resource を組むので、クライアントが resource を差し替えられない。`consume` は userId・binding (bearer の hash)・action・resource を全部照合 | `passkey-handler.ts pairingApprove`, `action-proof.ts consume` |
| epoch | pairing 作成時の `auth_epoch` を begin・finish・approve の 3 箇所で `users.auth_epoch` と照合。回復・admin 付与で epoch が進むと古い pairing は全部死ぬ | `device-pairing.ts` |
| 期限 | QR 3 分 (`expires_at`)、claim 後 10 分 (`claimed_at + 10min`)。`stateOf` が両方見る | 同上 |
| 並行 | token claim は `UPDATE ... WHERE claimed_at IS NULL ... RETURNING` で 1 件。finish / approve は `users` と `device_pairings` を `FOR UPDATE`。candidate は `lockOpenCandidate` で `FOR UPDATE` | 同上 |
| 照合番号の推測 | 2 桁は秘密ではない (設計どおり)。番号を知っても承認は proof 必須 | — |
| 別ユーザーの pairing 操作 | status / approve / reject / candidateId の全 query に `user_id = 自分` の条件 | 同上 |
| token の総当たり | 32 byte 乱数の sha256 digest を unique index で引く。IP ごと 60/10 分 | `pairingRegisterBegin` |
| 盗んだ bearer だけでの操作 | `device-link` と `device-pairing-reject` は bearer のみ。攻撃者は自分の候補を作れるが承認できず、正規候補を**拒否して妨害**はできる (DoS のみ) | — |

### 2.2 承認 UI の前提 (F7, 中)

- **前提**: 攻撃者が被害者の PC の QR を盗み見・撮影する (設計 §11 の脅威)。
- **手順**: 攻撃者が先に token を claim して候補を登録 → 被害者のスマホは「Pairing link is invalid or expired」。PC には攻撃者の候補が `candidateLabel` (UA 要約 = 攻撃者が被害者のスマホに合わせられる) と 2 桁番号つきで出る。被害者は「スマホに番号が出なかったけど PC には出ている」状態で、承認ボタンを押せる。
- **影響**: 攻撃者のパスキーが有効化され、以後その鍵でログインできる (通知は届くが後の祭り)。
- **修正案**: 比較: (a) 現状 = PC に番号を表示し yes/no (番号は照合に使われない)。(b) **番号は スマホにだけ表示し、PC で入力させてサーバーで照合** (`device-pairing-approve` の payload に `matchCode` を要求し `approvePairing` で一致確認。不一致 N 回で pairing を失効)。(c) 番号を 6 桁にして (b)。推奨 (b)。2 桁でも「スマホに出た番号を知っている」ことを要求できれば、スマホを持たない攻撃者は承認を得られない。(c) は UX を悪くする割に、2 桁の推測は proof が要るため実益が薄い。

### 2.3 その他

- F11: `finishPairingRegistration` の `nickname` は QR を読んだ側の入力で、`passkey.added` 通知には `candidateLabel` を使うので通知には出ないが、`promotePasskeyCandidate` 経由で `passkeys.nickname` になる。所有者の一覧で「iPhone (本人)」などを騙れる。承認後は所有者が付け直す UI にするか、承認時に PC 側で nickname を与える。
- `beginPairingRegistration` は token 提示だけで `account.label` (表示名) を返す。QR 漏えい = 表示名漏えい。同意画面の要件なので設計どおり。

---

## 3. リカバリー QR

### 3.1 確かめた点 (不成立 N4)

| 観点 | 結果 | 根拠 |
|---|---|---|
| 照合 | `parseRecoveryCode` で形式検証 → `recoveryId` で行を引く → HMAC を `timingSafeEqual`。不一致・使用済み・失効・admin・保留中は同じ 401 文言 | `recovery-code.ts findActiveRecoveryCode`, `recovery-request.ts` |
| 列挙 | recoveryId 16 byte 乱数。行の有無で HMAC 計算の有無が変わる時間差はあるが、128 bit 空間の列挙には使えない。IP 15/分 + 全体 600/分 | `recovery-code-handler.ts limitAnonymous` |
| 世代 | begin・finish・confirm の 3 箇所で `users.recovery_generation` と code / request の generation を照合。再発行・確定・運用者回復で +1 | `recovery-code.ts invalidateSelfRecovery` |
| 待機 | `eligible_at` はサーバー時刻、confirm で `> now` なら 409。前倒し経路無し | `confirmRecovery` |
| 取消 | proof (`recovery_request.cancel`, resource = requestId) は `passkeys` の有効なキーでしか取れない。候補キーでは `action-auth begin` が allowCredentials に入れない | `action-auth-handler.ts` |
| 確定 | `users`・`recovery_requests`・`user_recovery_codes`・candidate を `FOR UPDATE`。epoch・generation・admin・frozen・eligible を再確認。旧パスキー全失効・Device Credential 失効・refresh 削除・epoch/mfaRevision/generation +1・code 使用済み・候補昇格を 1 tx | `confirmRecovery` |
| 運用者回復との連動 | `completeRecovery` が `invalidateSelfRecovery` を呼び、保留中の要求と候補・コードを全部失効 | `registration-grant.ts:110` |
| admin 除外 | begin・finish・confirm の 3 箇所で `role === "admin"` を拒否 | — |
| 候補キーで login / proof | 不可 (§2.1) | — |
| DoS | userId 単位の制限が無いので第三者が本人の枠を潰せない。保留要求は user ごと 1 件 (unique index) | — |

「取消は要求作成前から有効な旧キー」(設計 §5.6) は実装では「現在有効な任意のキー」だが、要求後に新しい有効キーを足すには旧キーの proof が要るため等価。

### 3.2 生きている WS セッションが失効しない (F3, 高)

- **前提**: 攻撃者が被害者の端末 (ログイン済みブラウザ) を盗む、または bearer を窃取して WS を張る。被害者はリカバリー QR で自己回復 (24h 後に確定) するか、運用者回復を受ける。
- **手順**: `confirmRecovery` / `completeRecovery` は `auth_epoch` を進め、`refresh_sessions` を削除し、Device Credential を失効させるが、**Redis の `session:{id}` (TTL 7 日) と `ustate:{user_id}` を消さず、`sessionRegistry` の接続も切らない**。`ws/auth.ts resolveWsAuth` は `session_id` での再接続時に token を再検証しない。`commands.ts dispatch` は Redis の session と user state しか見ない (`authEpoch` を見る箇所が WS 層に無い。`grep authEpoch server/src/ws/*` は composite-auth のみ)。
- **影響**: 回復後も攻撃者の WS セッションは最長 7 日 (切断後も `session_id` で再接続可) 生き続け、proof 不要の WS コマンド (`profile.update`, `user.search`, `managed_project.my_data/my_data_all/open_url`, `login_alert.verify`, relay、組織 admin なら `member.add/remove` など) を実行できる。設計 §11「既存セッションの迂回」と schema の注記 (`auth_epoch` で「旧 access token / WS session を無効化」) は WS には当てはまっていない。運用者回復 (既存機能) にも同じ穴がある。
- **修正案**: 比較: (a) `RedisSession` に `authEpoch` を持たせ、`dispatch` の Layer 2 で `users.auth_epoch` と照合 (DB 1 クエリ増。確実)。(b) 回復 tx の commit 後に `sessionRegistry.getByUser(userId)` を `ws.end(1008)` し、該当 `session:{id}` を `deleteSession`、`ustate` を `session_expired` にする (即時。別プロセスの接続には届かないので単独では不足)。(c) `resolveWsAuth` の `session_id` 再接続で `accessToken` (Redis に保存済み) を `verifyToken` し直す (再接続は塞げるが接続中は塞げない)。**推奨 (a) + (b)**。(a) は `getUserState` と同じ場所で済み、(b) は体感即時性のため。

### 3.3 運用者が要求を止められない (F4, 中)

`recovery_requests.frozen_at` は `confirmRecovery` で読まれるだけで、書く経路が無い (`grep frozenAt` = schema・migration・confirm の 3 箇所)。`account_recovery` WS は `issue` / `revoke` (運用者 grant の発行・取消) のみ。被害者が「QR を盗まれた、旧キーも無い」と申告しても、運用者は `issueRecoveryGrant(revokeAllExistingPasskeys)` → 被害者がパスキー登録 → `completeRecovery` の完走でしか盗難者の要求を消せない。本人確認から完走までの間に 24h が過ぎれば盗難者が勝つ。

修正案: `account_recovery.freeze { requestId }` (system admin + action proof) を追加して `frozen_at` を書く。`cancel` にするか `freeze` にするかの比較: freeze は後で解凍できる (誤申告対策) が、解凍 API も要る。まずは freeze + 運用者回復完走で消える現状の連動で足りる。

### 3.4 正規保持者が締め出される (F9, 中)

`beginRecoveryWithCode` は `hasOpenRequest` で 401 を返す (文言も同じ)。盗難者が先に要求を出していると、本人は「コードが無効」としか見えず、旧キーが無ければ取消もできない。設計の「先着 → 24h → 確定」の帰結だが、本人側に打つ手が無いのは重い。

比較: (a) 現状 (運用者窓口のみ)。(b) **同じコードの 2 回目の提示で保留中の要求を取り消す** (コード保持者は取消方向にだけ使える。盗難者も本人の正規要求を取り消せるが、どちらも確定できないので「誰も勝てず運用者へ」に収束する。盗難 QR で乗っ取られる方が、相互 DoS より悪い)。(c) 2 回目の提示で「競合」を本人に見せ、両方を失効 + コード失効 (= (b) と同じ結果を明示的に)。推奨 (c)。実装は `beginRecoveryWithCode` の `hasOpenRequest` 分岐で、コードが一致したときだけ `cancelRecoveryRequest` 相当を行い、専用の応答 (`recovery_conflict`) を返す。

### 3.5 その他

- F15: `finishRecoveryWithCode` は `hasOpenRequest` を tx 内で見るが、同一ユーザーの並行 finish は `users` の `FOR UPDATE` で直列化されるので実際には起きにくい。起きた場合は `uq_recovery_requests_open` 違反で 500。`AppError.unauthorized(INVALID_CODE)` に揃える。
- `confirmRecovery` は旧 epoch の `device_pairings` と pairing 候補を失効させない。`approvePairing` の epoch 照合で承認は不可能なので実害無し。整理のため `invalidateSelfRecovery` 相当で pairing も失効させると画面が混乱しない。
- `completedRecoveryWithin` による猶予 (確定から 15 分、proof 無しで初回コード発行) は、確定直後に新キーの bearer を持つのは確定者本人だけなので妥当。
- 運用者 grant (`registration_grants`) が有効なまま自己回復が確定した場合、grant の `completeRecovery` が epoch を照合するかは未確認 (本ブランチ外)。TTL 15 分なので低リスク。

---

## 4. 通知

### 4.1 確かめた点 (不成立 N5)

| 観点 | 結果 | 根拠 |
|---|---|---|
| 宛先の乗っ取り・偽装 | 宛先は `users.discord_id` / `users.google_verified_email` だけ (`linkedAddress`)。任意アドレスを登録する入力が無い。連携は Bearer + proof の link grant 経由で、他ユーザーに連携済みの外部アカウントは拒否 (`existing[0].id !== linkUserId`) | `alert-targets.ts`, `oauth-handler.ts` |
| 確認番号 | 6 桁、`verification_attempts` 5 回、10 分。番号を知っても得られるのは「自分の連携先へ通知が届く」だけで権限は無い | `verifyAlertTarget` |
| 宛先追加・削除の proof | `login_alert.start/remove` は WS 層で `login_alert.manage` (resource = channel) を要求 | `action-policy.ts resolveWsActionTarget` |
| 変更前の宛先にも送る | `alert_target.added` は `verified_at` を立てる**前**に記録するので、新宛先を除く既存宛先へ届く。`removed` は `removed_at` を立てる前に記録 | `alert-targets.ts:126,150` |
| outbox の重複・欠落 | 出来事と同じ tx で挿入。`FOR UPDATE SKIP LOCKED` + lease で多重 worker でも二重に掴まない。送信直後のクラッシュで at-least-once (設計どおり)。恒久失敗で `failed_at` + degraded | `outbox-worker.ts`, `security-events.ts` |
| 通知文への注入 | `detail.device` は `summarizeUserAgent` の固定語彙 (`Chrome / Windows` 等、最大 64 文字) なので UA からの注入は不可能。Discord は `allowed_mentions: { parse: [] }`。メールは本文 text、件名固定 | `lib/user-agent-summary.ts`, `discord-alert-sender.ts` |
| 通知の洪水 | 自分宛にしか送れない (`start` は自分の連携先、`session.new` は自分のログイン)。他人への洪水は、他人のアカウントで出来事を起こす必要があり、それ自体が成立しない | — |
| `markAlertTargetDegraded` が (channel, address) で全ユーザーに効く | 外部アカウントはユーザー間で一意 (link の重複拒否) なので他人の宛先を degraded にできない | — |

### 4.2 記録漏れと読み出し手段の欠如 (F6, 中)

`recordSecurityEvent` の呼び出し元: pairing (requested / added)、recovery (requested / cancelled / completed / code_reissued / operator)、login (`session.new`)、alert_target (added / removed)。

- **`passkey.added` が記録されない経路**: プロフィールからの `register-begin/finish` (`passkey-handler.ts registerFinish`)。攻撃者が被害者の端末で (proof を取れる状況で) 鍵を足した場合、通知は出ない。
- **`passkey.removed` は一度も記録されない** (`deletePasskey` に呼び出し無し。`SecurityEventKind` に定義だけある)。
- **`session.revoke_all` は一度も記録されない** (`device-command.ts revoke_all`)。
- **`security_events` を読む API が無い** (`grep securityEvents` の読み手はゼロ)。設計 §7 の `/security` 画面 (「心当たりがない」導線) は本ブランチではフロントも API も無い。relay 通知は配送時点で接続中のセッションにしか届かず (`sessionRegistry.sendToUser`)、後からログインした本人が出来事を知る手段が **`recovery-code-status` の `pendingRecovery` だけ**。設計 §7 の最重要出来事 (回復要求) については、通知先を設定していない利用者には「24h 以内にたまたま Cr に接続している」以外の検知手段が無い。

修正案: 3 箇所に `recordSecurityEvent` を足す (`deletePasskey` は tx 内、`revoke_all` は `revokeAllDeviceCredentials` の tx 内)。`security_event.list` WS (本人、直近 N 件) を足し、`/security` の実装単位 5 に含める。未読の `critical` 出来事があればログイン応答 (`loginFinish` / `exchange`) に `pendingAlerts: n` を載せ、クライアントが `/security` へ誘導できるようにする。

### 4.3 Discord の escape (F10, 低)

`sendDiscordDm` は本文全体に `escapeDiscord` を掛ける。固定文の `https://.../security` が `https\://...` になり、`日時\:` のように表示される。Discord はバックスラッシュを表示上は消すが、URL の自動リンクは効かない可能性が高い (要実機確認)。escape 対象は可変部分 (device など) に限定し、`renderAlertMessage` に escaper を渡す形にする。可変部分は現状固定語彙なので、escape 自体は防御的措置として残してよい。

### 4.4 その他

- Google 宛先は `googleVerifiedEmail` (Google の `email_verified=true`) に限る。`users.email` (MFA 用) を宛先にしない設計が守られている。
- `deliverVerificationCode` は `start` の tx 外で送るので、送信失敗時は `removed_at` を立てて「設定済みに見せない」。良い。

---

## 5. 「誰でも即時にアカウントを作れる」ことで広がる攻撃面

前提: `signup-begin` → `create()` → `signup-finish` でソフトウェア認証器 (任意の WebAuthn 実装) から `role=general` のアカウントを作れる。IP ごと 5/10 分以外の上限は無い (F13)。1 アカウントで **Cr の WS (全モジュール)**・`composite-session-code`・`project-token`・`exchange` が使える。

### 5.1 relay が任意ユーザーへ届く (F1, 高)

- **前提**: 一般アカウント 1 つ + 対象ユーザーの userId (後述 F2 で取れる) または sessionId。
- **手順**: 自分の WS から `{ type: "relay", target: { user: "<victim userId>" }, payload: {...} }`。`ws/handler.ts:218` は `sessionRegistry.relay(data.sessionId, data.userId, msg.target, msg.payload)` をそのまま呼び、`relay()` は `{user}` / `{session}` で送信元ユーザーを一切見ない。CLAUDE.md §1.2 Step 4「デフォルトでは同一ユーザーのセッション間のみ」は実装されていない。
- **影響**: (1) 任意ユーザーの全セッションへ `relayed` を無制限に押し込める (クライアント側の処理次第で UI の偽装・スパム・負荷)。(2) ログイン通知は `type: "event", event: "security_alert"` で別形式なので、relay でセキュリティ通知そのものを偽造はできないが、クライアントが `relayed` を信頼して画面に出す設計 (クロスデバイス同期) なら「偽の警告」「偽の承認依頼」を出せる。(3) 送信元は `from_session` (sessionId) しか付かず、受信側はユーザーを特定できない。
- **修正案**: 比較: (a) `{user}` は `target.user === fromUserId` のときだけ、`{session}` は対象セッションの userId が自分のときだけ許可 (CLAUDE.md の既定どおり。最小変更)。(b) 組織メンバー間を許可する allowlist (プレゼンス等の用途があるなら)。(c) 受信側 opt-in (capability token)。**推奨 (a)**。(b) は要件が無い限り足さない。加えて `relayed` に `from_user` を付け、レート制限 (session ごと N/秒) を置く。

### 5.2 全ユーザーのメール・role の取得 (F2, 高)

- `user.search { query }` (2 文字以上, ILIKE, 10 件): `login` / `display_name` / **`email`** を部分一致で検索し、`id, login, displayName, avatarUrl, email` を返す。認可無し。`"@g"`, `"@ex"` のような query で 10 件ずつ、文字を変えながら全ユーザーのメールを収穫できる。
- `user.get { userId }`: `email` と `role` を返す。**role が返るので admin の特定**ができる (運用者へのソーシャルエンジニアリングの標的化)。
- 設計 §6 でメールは「登録時に集めない」が、MFA 用・edge 由来・Google 連携で `users.email` は残る。
- **修正案**: 比較: (a) `user.search` / `user.get` から非 admin への `email` と `role` を外す (最小)。(b) 検索対象を「自分と組織を共有するユーザー」に限る。(c) 検索をサービス側 (project WS の profile_access grant) に寄せ、ユーザー WS から外す。**推奨 (a) を即時、(b) を登録許可制の設計 ([tasks/2026-10-14-registration-approval-design-request.md](../tasks/2026-10-14-registration-approval-design-request.md)) と合わせて**。

### 5.3 組織の非メンバーによる閲覧 (F5, 中)

- `member.list { organizationId }`: メンバーの `userId, role, login, displayName, avatarUrl, email`。`requireOrgRole` 無し。
- `organization.get`、`organization.presence` (在席状況)、`org_project.list`: 同様に認可無し。
- 必要なのは組織 UUID。`organization.list` は自分の所属分しか返さないので、UUID は別経路 (URL・他サービス・在席共有イベント) で知る必要がある。UUID の推測は不可能なので「中」。
- **修正案**: `list` / `get` / `presence` / `org_project.list` に `requireOrgRole(userId, orgId, ["member","admin","owner","maintainer"])` を足す。system admin は通す。

### 5.4 他サービスへの横展開 (設計どおりだが明記)

| 経路 | 内容 |
|---|---|
| `POST /api/auth/project-token { project_key, hub_url }` | 任意の有効な managed project 向けの `user_for_project` PASETO を得る。サービス側は Cr の署名だけで「正規ユーザー」として扱う |
| `POST /api/auth/composite-session-code { target }` | 許可 target 向け authCode → `exchange` でサービスが Cr の access/refresh を受け取る (`auth-code.ts issueAuthCode` は **Cr の access/refresh そのもの** を authcode に入れる。サービス backend が Cr のフルセッションを持つ構造は既存) |
| composite login → `ensureUserProjectRow` | 全サービスの `project_data_<key>` に行が作られる |
| `managed_project.list/get/templates/connections/definition_history` | 一般ユーザーが全 managed project の定義・接続情報を読める (`connections` が何を返すかは本ブランチ外、要確認) |
| `project_definition.list/get` (F12) | `data_sharing` / `profile_access` / `pluginRepository` を含む定義の偵察 |

これらは「Cr の一般ユーザー = 全サービスの一般ユーザー」という設計そのものであり、各サービスの認可が守りの主体になる。登録許可制 (別依頼) が無い間は、**各サービスの「一般ユーザーが読める他人のデータ」がそのまま匿名者に開く**。本検証の範囲外だが、各サービス側で「Cr の general ロール = 未審査のインターネット利用者」として扱い直す必要がある。

### 5.5 アカウント量産 (F13, 低)

`signupBegin` は IP ごと 5/10 分のみ。全体 burst 上限 (設計 §0 「失敗ベース + 全体 burst」) が無い。分散 IP で `users` / `passkeys` / `refresh_sessions` / `operation_logs` / `security_events` を無制限に増やせ、§5.1〜5.3 の踏み台になる。全体 `passkey-signup:global` (例 300/10 分) を `limitAnonymous` と同じ流儀で足す。

---

## 6. その他の実装上の誤り

| # | 内容 | 影響 | 修正 |
|---|---|---|---|
| F14 | `registerFinish` は `redis.get` → insert → `redis.del`。`registerBegin` の challenge は `passkey:challenge:reg:<userId>` でユーザー単位 | 検証失敗後も challenge が残る (署名が要るので再利用は不可)。並行 begin は後勝ちで前の ceremony が失敗 | `getdel` に揃える。ceremonyId 単位のキーにする (pairing / recovery と同じ) |
| F16 | `ws/guest.ts` 既定エラー「Use 'register' or 'login'」 | 文言のみ | 修正 |
| — | `pairingApprove` の `claims.authEpoch ?? 0` | `generateAccessToken` は常に `authEpoch` を入れるので実害無し | `?? 0` を外して欠落を 401 にする方が安全 |
| — | `confirmFinish` は `logUserLogin` を呼ばない | 監査ログに回復ログインが「login」として残らない (`recovery.completed` は残る) | `logUserLogin(..., "passkey-recovery")` を足す |
| — | `loginBegin` の `email` 指定で `allowCredentials` の有無が変わる | メールの存在列挙 (既存) | メール指定時も空 allowCredentials を返さない (常に discoverable) か、存在しないメールにもダミーを返す |
| — | `signup-finish` 後の `/onboarding` (名前・QR・pairing・通知先) と `/recover`・`/security`・`/device-register`・Signal API はフロント未実装 (本ブランチに `frontend/` の差分無し) | 実装単位 5・6 が未着手なので、§4.2 の「本人が気づけない」が現時点では全面的に当てはまる | 本書の F6・F7 を実装単位 5 の受入条件に入れる |

---

## 7. 修正案の一覧 (優先順)

| 優先 | 対象 | 修正 | 変更箇所 |
|---|---|---|---|
| 1 | F1 | relay の `{user}` / `{session}` を自分のセッションに限定。`from_user` 付与。レート制限 | `ws/session-registry.ts relay()`, `ws/handler.ts` |
| 2 | F3 | Redis session に `authEpoch` を持たせ `dispatch` で照合 + 回復 tx 後に該当ユーザーの WS を `end(1008)`・`deleteSession`・`ustate=session_expired` | `redis.ts`, `ws/auth.ts`, `commands.ts dispatch`, `recovery-request.ts confirmRecovery`, `registration-grant.ts completeRecovery` |
| 3 | F2 | `user.search` / `user.get` から非 admin への `email`・`role` を外す。検索範囲を共有組織に限る案は登録許可制と合わせて決める | `commands.ts userCmd` |
| 4 | F5 | `member.list` / `organization.get` / `presence` / `org_project.list` に所属確認 | `commands.ts` |
| 5 | F7 | `device-pairing-approve` に `matchCode` を要求しサーバーで照合。不一致 3 回で pairing 失効。スマホにだけ番号を表示 | `device-pairing.ts approvePairing`, `http/passkey-handler.ts pairingApprove` |
| 6 | F6 | `passkey.added` (`registerFinish`)・`passkey.removed` (`deletePasskey`)・`session.revoke_all` を記録。`security_event.list` WS を追加。ログイン応答に未読 critical 件数 | `passkey-handler.ts`, `device-command.ts`, `commands.ts` |
| 7 | F4 | `account_recovery.freeze { requestId }` (admin + proof) で `frozen_at` を書く | `auth/recovery-command.ts`, `action-policy.ts` |
| 8 | F9 | 保留中にコードが再提示されたら競合として両方失効 + 専用応答 | `recovery-request.ts beginRecoveryWithCode` |
| 9 | F8 | signup 系の `expectedOrigin` を Cr origin に限定 | `passkey-handler.ts finalizePasskeySignup` |
| 10 | F13 | signup の全体 burst 上限 | `passkey-handler.ts signupBegin` |
| 11 | F10 | Discord escape を可変部分に限定 | `notify/alert-message.ts`, `discord-alert-sender.ts` |
| 12 | F11, F14, F15, F16, §6 | 小修正 | 各所 |
| 13 | N2 | 死んだ MFA ログイン入口 (REST `mfa/verify`、guest / composite / project WS の `mfa-verify`) を削除し、`issueMfaLogin` を消す | `mfa-handler.ts`, `guest.ts`, `composite-handler.ts`, `project-dispatch.ts` |

1〜4 は本ブランチの新規コードではないが、パスキーのみ化で「誰でも一般アカウント」になった瞬間に匿名者へ開くため、**同じリリースで直す**ことを推奨する。5〜8 はパスキーのみ化の中核 (pairing・回復) の残課題で、フロント実装 (単位 5) の前に決める。

---

## 8. 前提未確定

- CORS: REST `/api/auth/passkey/*` が composite 許可 origin から直接叩けるか (F8 の実害の大きさ) は `app.ts` の CORS 設定を見ていない。
- Discord のバックスラッシュ表示と自動リンクの挙動 (F10) は実機未確認。
- `managed_project.connections` / `definition_history` が一般ユーザーに何を返すか (§5.4) は `project/service.ts` を読んでいない。
- 運用者 grant の `completeRecovery` が自己回復による epoch 変化を検出するか (§3.5) は未確認。
