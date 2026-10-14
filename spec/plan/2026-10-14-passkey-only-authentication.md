# Cernere パスキーのみの認証へ移す (統合設計)

2026-10-14 / neco 指示。ログイン時の攻撃耐性を上げるため、利用者のログイン手段をパスキーだけにする。
既存の [passkey-default-authentication.md](passkey-default-authentication.md) (端末セッション・運用者回復) を前提に、
「入口の統合」「名前の後入れ」「別端末の追加」「利用者自身の回復」「旧方式の廃止」「ログイン通知」を足す。

初稿を Fable と Astra に独立にレビューさせ、本書はその統合版。
レビュー全文: [Fable](2026-10-14-passkey-only-authentication-review-fable.md) / [Astra](2026-10-14-passkey-only-authentication-review-astra.md)。

## 0. 決定事項

### neco の指示

| 項目 | 決定 |
|---|---|
| ログイン手段 | パスキーのみ。登録とログインを区別しない入口 |
| 名前 | 初回ログインの後に入れる |
| 端末を変えたときの備え | 初回が PC なら、スマホのパスキーを Cr に登録させる QR を出す。スマホなら何もしない |
| 自力回復 | 登録時に、識別子と秘密値を埋め込んだリカバリー用 QR 画像をダウンロードさせる |
| メール | 登録時に集めない。後から任意で足せる、MFA 用のレガシー経路 |
| 旧方式 | メール+パスワード、Google ログイン、GitHub ログインは即時に全廃 |
| ログイン通知 | Discord または Google を使った代行通知 |

### レビューの統合

| 論点 | Fable | Astra | 採用 | 理由 |
|---|---|---|---|---|
| 回復 QR の即時全失効 | 盗難時に本人を締め出す。24h 保留 + 取消 | 同じ。24h 待機、旧キーで取消 | **24h 保留 → 新キーで確定** | 一致 |
| 回復 QR の識別子 | userId を外し乱数 codeId | 同じ | **乱数 recoveryId** | 一致。userId 単位の制限による DoS も消える |
| 回復の取消手段 | 通知に取消専用 token | 旧キーの fresh proof か運用者のみ。通知 token は通知先侵害で DoS 権になる | **Astra 案** | 通知先 (Discord / Google) の侵害を Cr の操作権にしない |
| 回復 T の例外 | 通知先も端末も無ければ即時 | 高権限は QR 自己回復不可 | **常に 24h。admin は QR 回復不可 (運用者のみ)** | 攻撃者に条件を操作させない単純な規則 |
| スマホ QR | 登録を pending、PC で 2 桁照合して承認 | 同じ。既存キーの proof を候補に束縛 | **両案** | 一致 |
| オンボーディング | Cr origin の /onboarding。埋め込み先に平文を通さない | 同じ。authCode 60 秒 TTL と整合させる | **Cr origin のみ。onboarding token は作らない** | 通常のログイン済みセッションで足りる |
| `/login` の扱い | — | client_credentials / project_credentials を壊すな | **人間の password 分岐だけ 410** | 実装時に同じ問題を見つけて対応済み |
| 通知経路 | WS relay を基底、Google メール主、Discord 副 | 到達確認付き Discord DM 主、Google メールは追加案 | **WS relay + Discord と Google の両方 (利用者が選ぶ)。どちらも到達確認で有効化** | neco 指示は「Discord または Google」。両方用意し、確認できた先だけ使う |
| 通知の配送 | Redis list + worker | DB outbox (欠落防止) | **DB outbox** | ログイン成功と通知記録を同じトランザクションにする |
| 移行 | 30 日のパスキー登録専用セッション | release gate で事前確認 | **移行窓なし。DB をリセット (§10)** | neco: Cr は本運用前 |
| edge assertion | 残してよい | 人間が承認するまで断定しない | **残す (企業限定の例外)** | §10 |
| 旧方式由来のセッション | — | 切替時に再認証 | **リセットで消えるので専用処理は持たない** | §10 |
| 最初の admin | 明示 bootstrap | 同じ | **明示 bootstrap** | 一致 |
| レート制限 | 失敗ベース + 全体 burst | begin/finish/全体の別予算 | **両案** | 一致 |
| 名前未設定の認証器表示 | プレースホルダ + Signal API | 同じ | **両案** | 一致 |
| conditional mediation | 採る | 補助。最初は明示ボタンで十分 | **明示ボタンのみ (初版)** | 名前もメールも聞かない画面に入力欄が無い |

## 1. 範囲

### SPEC-LEGACY-LOGIN-RETIRED

廃止 (410 `{ error: "login_method_retired", method }`):

- `POST /api/auth/register`、`POST /api/auth/login` の利用者メール+パスワード分岐
- composite REST と project WS の `login` / `register`、ゲスト WS の `register` / `login`
- `GET /auth/github/login`、`GET /auth/google/login`。callback は有効な link grant に解決できたものだけ成功させ、それ以外 (通常ログイン state・期限切れ・不明) は拒否する

残す:

- `/api/auth/login` の `grant_type=client_credentials` (tool) と `project_credentials` (project)。人間のログインではない
- OAuth の**アカウント連携** (GitHub / Google / Discord)。ログインには使わない。§7 の通知先の確認に使う
- 運用者による回復、Device Credential、MFA (step-up 用)

DB の `password_hash`・`google_id`・`github_id` 列と値は消さない。

### 既存ユーザーと既存セッション

Cr は本運用前のため、切替時に DB をリセットする (neco 2026-10-14)。移行窓・旧方式由来セッションの再認証処理は持たない。リセット後の最初の admin は §8 の明示 bootstrap で付与する。リセットの実施は neco が行う。

## 2. 入口の統合

### SPEC-PASSKEY-CONTINUE

画面のボタンは「パスキーで続ける」1 つ。

1. `login-begin` (discoverable) → modal `navigator.credentials.get()` → 成功なら `login-finish`。
2. `NotAllowedError` は「アカウントが無い」と表示しない。選択肢を次の順で出す: 再試行 /「他の端末にある」(ブラウザのクロスデバイス QR の案内、リカバリー QR) /「新しく始める」(最下段)。
3. 通信断・Origin/RP 設定不備・非対応ブラウザでは「新しく始める」に誘導しない。
4. 「新しく始める」→ `signup-begin` (name・email を受け取らない。送られたら 400) → `create()` → `signup-finish`。ユーザー行は WebAuthn 検証の成功後にだけ作る。

composite (埋め込み SDK) のログインは同じ順序にする。**新規作成は Cr origin の popup でだけ行う** (§3 のオンボーディングを Cr で済ませてから authCode を親へ返す)。経路 A (サービス backend → project WS) の `passkey-signup-*` は 410 にする。メール/パスワード欄と Google/GitHub ボタンは UI から消す。

### SPEC-DISPLAY-NAME-DEFERRED

- 作成時は `display_name=''`、`login=''`、`display_name_source='unset'`。
- 認証器へ渡す `user.name` / `displayName` は `Cernere <userId 先頭 8 桁>`。user handle (userId) は変えない。
- 名前設定後、対応ブラウザでは `PublicKeyCredential.signalCurrentUserDetails` で認証器側の表示を更新する (非対応は旧表示のまま)。
- `display_name_source='unset'` のユーザーは名前入力へ送る。下流へは `displayName: null` を渡す (exchange・userinfo)。

## 3. オンボーディング (Cr origin)

### SPEC-PASSKEY-ONBOARDING

`/onboarding` は Cr フロントの通常のログイン済みページ。専用 token は作らない。順序:

1. 名前 (既存の profile 更新)
2. リカバリー QR の発行とダウンロード (§5)
3. PC なら別端末 (スマホ) の追加 (§4)
4. 通知先の設定 (§7。任意)

「作成直後の猶予」: アカウント作成から 15 分以内かつ有効なリカバリーコードが無い場合に限り、初回のリカバリーコード発行と初回の device pairing 開始を action proof 無しで許す (作成時の UV を根拠にする)。それ以外は通常どおり fresh action proof を要求する。

`signup-finish` の応答はこれまでどおり JWT (Cr) / authCode (composite) のみ。秘密値を含めない。秘密値を返す応答はすべて `Cache-Control: no-store`。

## 4. 別端末の追加 (PC → スマホ)

### SPEC-DEVICE-PAIRING

既存の device-link を「即時登録」から「保留 + 元端末承認」に変える。プロフィールから出す追加 QR も同じ。

1. PC (ログイン済み): `device-link` で pairing を作る。token は 32 byte 乱数、digest 保存、TTL 3 分、未使用の前回 pairing は失効。QR の URL は `/device-register#t=<token>` (fragment)。
2. スマホ: ページ読込で fragment を履歴から消し、「<表示名 or 短縮 ID> のアカウントに、この端末のパスキーを追加します」を表示して同意を求める。
3. スマホ: `device-register-begin` → `create()` → `device-register-finish`。UV 済みの credential を **pending** で保存し、2 桁の照合番号を返す。**セッションは発行しない**。
4. PC: `device_pairing.status` で候補 (端末の概略と照合番号) を表示。利用者は両画面の番号が一致することを確かめて承認する。承認は fresh action proof を `pairingId + candidateCredentialId` に束縛して送る。
5. 承認・有効化・pairing 消費を 1 トランザクションで行う。スマホは新しいパスキーで通常どおりログインする。
6. 拒否・期限切れの候補は失効する。

画面には「この QR を他人に見せない」「サポート担当に QR や番号を送らない」を出す。クライアントの PC/スマホ判定 (`navigator.userAgentData?.mobile` → UA) は表示の出し分けだけに使う。スマホでもプロフィールからいつでも追加できる。

### SPEC-PASSKEY-PENDING

`passkeys.status` (`active` / `pending` / `revoked`) を追加する。`login-finish` と action proof は `active` だけを受け付ける。既存行は `active`。

## 5. リカバリー QR

### SPEC-RECOVERY-QR

- 形式: `CRRC1.<recoveryId>.<secret>`。recoveryId は 16 byte 乱数、secret は 32 byte 乱数 (どちらも base64url)。userId を載せない。
- 保存: `user_recovery_codes(id=recoveryId, user_id, secret_digest, key_id, generation, created_at, revoked_at, used_at)`。digest は `HMAC-SHA256(key[key_id], len‖"cernere-recovery-v1" ‖ len‖recoveryId ‖ len‖secret)`。鍵は `CERNERE_RECOVERY_CODE_KEY` (Vault)、DB と別に置く。有効なコードはユーザーごとに 1 件。
- 発行: `recovery_code.issue` (WS)。§3 の猶予内は proof 無し、以外は fresh action proof。古いコードを失効させ、平文を一度だけ返す。応答消失時は再発行 (旧コードは無効) で対応し、平文の再表示はしない。
- 画像: クライアントで生成 (既存 `qrcode`)。秘密値・発行日・版だけを入れ、氏名・userId を印字しない。手入力用の文字列も併記。ファイル名は `cernere-recovery-<発行日>.png`。「この画像を持つ人はアカウントを取り戻せる」「端末と同じクラウド写真庫だけに置かない」「印刷して保管を推奨」を表示する。
- 保存確認: 任意で保存した画像を読み戻し、クライアントでデコードして recoveryId だけをサーバーで照合する。ダウンロード押下は保存の証拠として扱わない。
- 失効の連動: 運用者回復の完了・QR 再発行・自己回復の確定で旧コードと保留中の回復をすべて失効する。

### SPEC-RECOVERY-QR-USE

1. `/recover` で QR を読む (カメラ / 画像ファイル / 手入力。デコードはクライアントで行い、外部サービスを使わない)。
2. `POST /api/auth/passkey/recovery-code-begin { code }`: 形式不正・不一致・使用済み・失効は同じ 401。対象ユーザーが admin なら同じ 401 (admin は運用者回復のみ)。
3. 一致したら WebAuthn 登録 ceremony (5 分、GETDEL 単回)。ceremony に recoveryId・generation・対象 auth_epoch を保存する。
4. `recovery-code-finish`: UV 必須で検証 → user → code の順にロック → 世代・未使用・epoch を再確認 → 新しいパスキーを **pending** で登録し、`recovery_requests(id, user_id, recovery_code_id, pending_passkey_id, created_at, eligible_at=created_at+24h, cancelled_at, completed_at)` を作る。既存のパスキー・端末は失効させない。通知の outbox を同じトランザクションで記録する。
5. 応答は `{ pending: true, eligibleAt }`。
6. 待機中の取消: 要求作成前から有効な旧キーの fresh action proof で `recovery_request.cancel`。取消すと pending キーとそのリカバリーコードを失効し、再発行を促す。運用者は本人確認の上で要求を凍結できる。新しい pending キーや QR 単独では取消・前倒しできない。
7. 確定: `eligible_at` 経過後、pending キーでの `login-finish` で確定処理を行う (cron 不要)。期限・未取消・世代・epoch を再確認し、同一トランザクションで、旧パスキー全失効・全 Device Credential 失効・refresh_sessions 削除・auth_epoch と mfa_revision の加算・コード使用済み化・pending キーの有効化を行う。その後、§3 と同じ扱いで新しいリカバリーコードの発行へ案内する。

### SPEC-RECOVERY-RATE-LIMIT

- begin / finish に IP (信頼済みプロキシからのみ) ごとの予算、全体の burst 上限、同時 ceremony 数の上限。
- userId 単位の予算は持たない (第三者が本人の回復枠を潰せないように)。秘密値検証後の有効要求にだけ、1 アカウントあたり同時 1 件の pending を課す。
- 連続失敗は内部検知に集約する (利用者への通知は大量失敗の集約のみ)。

## 6. メール

### SPEC-EMAIL-OPTIONAL-MFA

- 登録・ログインのどの画面でもメールを聞かない。
- プロフィールで任意に追加できる。確認済みメールはメール OTP の step-up に**追加条件として**だけ使う。パスキーの fresh action proof の代わりにはしない (リカバリー QR 再発行・キー追加・通知先変更・回復取消)。

## 7. ログイン通知

### SPEC-LOGIN-ALERT

出来事は成功トランザクションの中で `security_events` と `notification_outbox` に記録し、worker が配送する。送信失敗でログインを止めない。

| 出来事 | 扱い |
|---|---|
| 新しいセッションの確立 (passkey login、device pairing 承認後、回復確定後) | 通常。refresh では送らない。同一出来事の重複だけ集約 |
| パスキーの追加 (pairing 開始 / 承認)・削除 | 即時 |
| 回復の要求・取消・確定、リカバリー QR の再発行 | 即時・最重要。待機期限と取消方法 (旧キーでログインして取消 / 運用者窓口) を示す。集約しない |
| 運用者回復・全端末ログアウト | 即時 |
| 通知先の追加・変更・解除 | 変更前の確認済み先にも送る |
| 大量の失敗 | 集約した警告だけ |

配送先 (利用者がプロフィールで選ぶ。複数可。到達を確認できた先だけ有効):

| 経路 | 有効化 | 送信 |
|---|---|---|
| 他セッション (WS relay) | 常に有効 | 既存 relay で `login_alert` を本人の他セッションへ |
| Discord | Discord 連携済み + 通知の同意 + 試験 DM の確認番号を Cr の設定画面で入力 | Cr 専用 Bot で `POST /users/@me/channels` → `POST /channels/{id}/messages`。`allowed_mentions` は空。429 は `Retry-After` に従い再試行、403/50007 は通知先を degraded にして画面に出す |
| Google | Google 連携済み (`email_verified=true`) + 通知の同意 + 確認メールのリンク | 既存 mailer (SES)。From 固定・Reply-To 無し |

内容: 出来事、時刻 (UTC と利用者向け時差表示)、ブラウザ/OS の概略、取得できるときの国、短いイベント番号、Cr の固定 URL (`/security`)。載せない: 完全な IP・精密位置・メール・userId・秘密値・トークン。UA・表示名は escape する。本文に「Cr はログインリンクを送らない。DM で何も尋ねない」を常記。リンクは固定 URL だけで、開いてもパスキーでのログインが要る。GET で状態を変えない。

`/security` (「心当たりがない」): 対象イベント、端末の失効、全端末ログアウト、**攻撃者が足したパスキーの失効**、保留中の回復の取消、リカバリー QR の再発行を一画面に置く (「アカウント保護」)。全端末ログアウトだけではパスキーが残ることを明示する。

Bot 所有: Cr 専用 Bot (LUDIARS 管理、token は Vault)。Conexus は現状 README のみなので配送責任を置かない。送信実装は `DiscordAlertSender` に閉じ、差し替えられるようにする。

## 8. 最初の admin

### SPEC-ADMIN-BOOTSTRAP

`users` が 0 件でも自動で admin にしない。admin の付与は `npm run bootstrap-admin -- <userId>` (サーバー上で実行) のみ。既存の DB には影響しない。

## 9. データ

| migration | 内容 |
|---|---|
| 065_passkey_status.sql | `passkeys.status text not null default 'active'` |
| 066_recovery_codes.sql | `user_recovery_codes`、`recovery_requests` |
| 067_device_pairings.sql | `device_pairings(id, user_id, token_digest, expires_at, candidate_passkey_id, match_code, approved_at, consumed_at, revoked_at)` |
| 068_login_alerts.sql | `security_events`、`notification_outbox`、`login_alert_targets(user_id, channel, address_ref, verified_at, degraded_at, version)` |

番号は実装時点の最大値と照合する。

## 10. 決定 (neco 2026-10-14)

| 事項 | 決定 |
|---|---|
| 移行窓 | 設けない。Cr は本運用前なので DB をリセットする。旧方式は即時 410 |
| edge assertion (Cloudflare Access 企業 SSO) | 企業限定の明示例外として残す。個人ログインや回復への迂回には使わせない |

## 11. 脅威と対策

| 脅威 | 対策 |
|---|---|
| パスワード総当たり・リスト型攻撃 | パスワード入口を廃止 |
| OAuth 側アカウント乗っ取りからの横展開 | OAuth ログインを廃止。連携はログインに使わない |
| フィッシング | WebAuthn の origin/RP ID 束縛 |
| リカバリー QR の窃取 | 24h 保留 + 旧キーでの取消 + 通知。admin は対象外 |
| スマホ用 QR の盗み見・逆向き QR | pending + 番号照合 + 元端末承認。同意画面に追加先アカウントを表示 |
| 埋め込み先サービスの侵害 | 秘密値と onboarding は Cr origin でだけ扱う。埋め込み先には authCode のみ |
| 通知先 (Discord / Google) の乗っ取り | 通知先には何の権限も持たせない。変更は旧通知先にも通知 |
| 通知フィッシング | テンプレート固定、ログインリンクを送らない |
| 運用者へのソーシャルエンジニアリング | 表示名・Discord ID の一致だけで本人と認めない。高権限は二者承認 |
| クラウド同期元 (Apple / Google) の乗っ取り | Cr では防げない。新セッション通知で検知。/devices に同期有無を表示 |
| 既存セッションの迂回 | 切替時の DB リセットで旧セッションが残らない |
| 最初のユーザーが admin を取る | 明示 bootstrap |

## 12. 実装単位

| # | 内容 | 状態 |
|---|---|---|
| 1 | 旧入口の 410、OAuth を連携専用に、signup から name/email を撤去 | 実装済み (e84687e) |
| 2 | 明示 admin bootstrap | |
| 3 | passkeys.status と device pairing (pending + 承認) | |
| 4 | リカバリー QR (発行・保留・取消・確定) と運用者回復との連動 | |
| 5 | フロント: 統合入口、/onboarding、/recover、/security、名前入力、Signal API | |
| 6 | composite: パスキーのみの UI、新規作成は Cr popup、経路 A の signup を 410 | |
| 7 | ログイン通知: outbox、WS relay、Discord、Google | |

composite パッケージは version を上げる。利用側サービスの SDK 更新は別作業。
