# レビュー: パスキーのみの認証 (攻撃耐性・ログイン通知) — Fable

2026-10-14 / 依頼文 [tasks/2026-10-14-passkey-only-auth-review-request.md](../tasks/2026-10-14-passkey-only-auth-review-request.md)。
対象は [2026-10-14-passkey-only-authentication.md](2026-10-14-passkey-only-authentication.md) (以下「設計書」)。前提として [passkey-default-authentication.md](passkey-default-authentication.md)、[interface/auth-flows.md](../interface/auth-flows.md)、`server/src/http/passkey-handler.ts`、`passkey-recovery-handler.ts`、`auth/registration-grant.ts`、`auth/passkey-rate-limit.ts`、`http/oauth-handler.ts`、`packages/composite/src/ui/` を読んだ。もう一方 (Astra) のレビューは見ていない。実装は行わない。

親の解釈 2 点への回答:

- 「UDID+ハッシュ」を「ユーザー ID + 秘密値、サーバーは HMAC digest のみ」と読んだ点は妥当。ブラウザは UDID を取れず、取れたとしても端末識別子を回復資格情報に混ぜる利点は無い。ただし QR に **userId をそのまま載せる必要は無い** (§2 で代替を示す)。
- edge assertion を廃止対象外とした点も妥当。上流エッジの署名済みアサーションで、Cr 側に推測可能な秘密 (パスワード) も、第三者の個人アカウント乗っ取りで横展開される経路も無い。ただし §4 のとおり「edge で自動作成されたユーザーはパスキーを持たない」ことを扱う必要がある。

---

## 結論 (重大度順)

| # | 重大度 | 指摘 | 節 |
|---|---|---|---|
| R1 | 重大 | リカバリー QR は単独で完全な乗っ取り + 本人締め出しを即時に成立させる bearer 資格情報。使用時の「全失効を即時」は盗まれた側に不利に働く。**猶予期間 + 通知からの取消** を入れる | §2 |
| R2 | 重大 | composite 経路A (サービス backend → project WS) で `signup-finish` を回すと、リカバリーコード平文と onboarding token が **第三者サービスのサーバーとログを通過**する。平文は Cr origin でしか扱わない構造に変える | §1, §6 |
| R3 | 重大 | 即時全廃で「パスキーを持たない既存ユーザー」と「パスキーを持たない運用者 (admin)」が同時に締め出されると、運用者回復自体が成立しない。切替前の admin 確認と、旧資格情報を「パスキー登録専用の制限セッション」にだけ使える移行窓を推奨 | §4 |
| R4 | 高 | PC→スマホ QR (device-link) は「最初に読んだ者が勝つ」。画面共有・撮影・スクリーンショット・サポート詐称での持ち出しで、読んだ側が本人の端末としてログイン状態になる。PC 側での **承認 (登録を保留して PC で確定)** を入れる | §1 |
| R5 | 高 | リカバリー QR の userId 単位レート制限 (1 時間 5 回) は、256 bit 秘密値への総当たり対策としては不要で、**userId を知る第三者が本人の回復を封じる DoS** になる。QR の識別子を乱数の code id に替え、userId 単位の制限を外す | §1, §2 |
| R6 | 高 | onboarding token は 15 分の間 device-link を 3 回発行できる = **15 分のアカウント乗っ取り資格情報**。応答 JSON・popup の postMessage・HAR に残る。device-link 発行は onboarding token 単独ではなく、直前の WebAuthn 作成の ceremony に束縛し、`Cache-Control: no-store`、postMessage 禁止を明記する | §1 |
| R7 | 高 | 運用者回復が「最後の手段」として相対的に最も攻撃しやすい経路になる。メールを集めないため本人確認の根拠が薄い。運用者回復にも猶予期間 (または 2 名承認) を付ける | §6 |
| R8 | 中 | 名前後入れで `user.name` / `displayName` が空のまま `create()` される。認証器の一覧で空欄になり、ブラウザによっては拒否される。プレースホルダ + Signal API (`signalCurrentUserDetails`) で後から更新する | §3 |
| R9 | 中 | 旧ログイン廃止後、composite 経路A のレート制限 (`passkey-signup` 5 回 / 10 分 / project) は **サービス全体で 10 分に 5 人しか新規登録できない** 上限になる。唯一の入口になる前に見直す | §1, §4 |
| R10 | 中 | ログイン通知は Discord / Google の二者択一より、**既存 WS relay による他セッションへの即時表示を基底** にし、外部通知は Google 連携で検証済みのアドレスへ SES で送る方式を主、Discord DM を任意の副とする | §5, §7 |

---

## 1. 攻撃耐性: 脅威モデルの漏れ

### 1.1 リカバリー QR = bearer 資格情報 (R1)

設計書 §5 は「単回使用・使用時に全端末失効・通知」を盗難対策としている。これは **盗んだ側にとっての最適手順** と一致する。

1. 攻撃者が PNG を入手 (ダウンロードフォルダ、クラウド同期された写真、チャットに貼ったスクリーンショット、印刷物の撮影)。
2. `recovery-code-begin` → 自分の認証器で `recovery-code-finish`。この瞬間に本人の全パスキー・全端末・refresh が失効し、**新しいリカバリーコードも攻撃者に渡る**。
3. 本人に残るのは運用者回復だけ。通知が届いても、取り消す手段が設計に無い (「心当たりがない」画面は device_session.revoke であり、既に本人のセッションは全部消えている)。

つまり通知は「事後報告」にしかならない。対策は §2 の **猶予期間付き回復** (使用から確定まで待機し、本人が既存端末または通知から取り消せる) に変えること。

### 1.2 composite 経路A で平文が第三者サーバーを通る (R2)

`executePasskeyCompositeAction` は project WS 経由で `passkey-signup-finish` を回せる (`passkey-handler.ts` §executePasskeyCompositeAction)。設計書 §2 の「`signup-finish` (REST・composite とも) は `onboarding.token` と `recovery.code` を返す」をこのまま適用すると、埋め込み先サービスの backend がリカバリーコード平文と onboarding token を中継し、そのサービスのログ・APM・エラートラッカーに残る。埋め込み先のサーバー侵害 = 全新規ユーザーの回復資格情報の流出になる。

推奨: 経路A・B とも finish は従来どおり `authCode` だけを返し、オンボーディング (名前・リカバリー QR・スマホ QR) は **Cr origin のページ** (`/onboarding`) で行う。composite は popup / 同一ウィンドウ遷移で `/onboarding` を開き、終わったら authCode を親へ返す (既存 `CompositePasskeyPopup` の流れに乗る)。経路A で埋め込みカード内に収めたい場合でも、リカバリーコード発行だけは Cr origin の popup に限定する。

### 1.3 PC→スマホ QR の持ち出し・中継 (R4)

device-link は URL を知る者が `device-register-begin` で GETDEL して勝つ。脅威:

| 経路 | 内容 |
|---|---|
| 盗み見 | 画面共有・配信・会議室のプロジェクタ・肩越し撮影。QR は読取距離が長い |
| サポート詐称 | 「本人確認のためプロフィールの QR のスクリーンショットを送って」。QR は本人にとって意味が読めないので抵抗が小さい |
| 逆向きの QR フィッシング (login CSRF 型) | 攻撃者が自分の device-link QR を「ログインはこれを読んで」と見せる。被害者は攻撃者のアカウントに自分のパスキーを足し、攻撃者のアカウントとしてログイン状態になる。被害者が入力したデータは攻撃者の口座に入る |
| 中継 (AiTM) | 攻撃者ページが本物の `/device-register` を iframe/プロキシで出す手口は、WebAuthn の origin 束縛で登録自体は失敗する。ただし「QR を読ませる→URL を攻撃者が先に叩く」の持ち出しは防げない |

推奨する変更:

1. **PC 側承認**: `device-register-finish` で作ったパスキーは `pending` とし、PC 画面 (onboarding/status または /devices) に「iPhone (Safari) から追加要求。確認コード 47」を出して PC 側が承認したら有効化する。スマホ側にも同じ 2 桁を表示し、一致を目視させる (Bluetooth 近接の代替として十分)。承認までスマホにセッションを発行しない。これで「先に読んだ者勝ち」を「PC の持ち主が決める」に変えられる。既存の device-link (プロフィールから発行) も同じ承認を要求する。
2. `/device-register` は必ず「**<表示名> のアカウントに、この端末のパスキーを追加します**」を出し、同意ボタンを押させる (逆向き QR 対策)。名前未設定時は短縮 ID と作成日時を出す。
3. token は URL の query ではなく **fragment** に載せ、読み込み後に履歴から除去する (運用者回復 grant と同じ扱い)。query だとブラウザ履歴・リファラ・プロキシログに残る。
4. QR の表示時間を短く (3 分) し、表示中は PC 側の画面に「他人に見せない」を出す。

### 1.4 onboarding token の権限が大きすぎる (R6)

`onboarding/device-link` は action proof 無しで 3 回まで device-link を出せる。device-link = 新しいパスキーの追加 = 乗っ取り。したがって onboarding token の流出は 15 分の乗っ取り資格情報の流出に等しい。流出面: `signup-finish` の JSON (HAR・devtools・プロキシ)、composite popup の postMessage、Redis 平文 (digest 保存なので可)。

推奨:

- 1.2 のとおり Cr origin のページで扱い、token を親ウィンドウへ渡さない。
- device-link 発行は 1 回まで (3 回は不要。1 回 = 1 台)。追加は 1.3 の PC 承認付きの通常経路。
- token の束縛に、直前の `signup-finish` の ceremony ID (= 作成した passkey ID) を入れるのは設計書どおり。加えて **同じブラウザ** に束縛する (HttpOnly Cookie に token を置き、JS に見せない)。Cr origin のページなら Cookie で済む。
- 応答に `Cache-Control: no-store`。

### 1.5 二重アカウント

設計書 §2 の「get → 失敗時に明示操作で create」は妥当な最小構成。残る穴は §3 で扱う。加えて: 二重作成されたアカウントの **統合手段が無い**。初期は「古い方を削除」で足りるが、リカバリー QR を 2 枚持つことになる利用者が混乱するので、`/onboarding` の作成直前に「すでにアカウントがある人はこちら (QR / 他端末)」を出す。

### 1.6 アカウント列挙

メールを集めないので、列挙面は userId (UUID) に移る。UUID v4 は推測不能なので列挙そのものは困難だが、**userId を知った後の振る舞いの差** に注意する。

- `recovery-code-begin`: 形式不正・不一致・使用済みを同じ 401 にするのは正しい。ただし userId 単位のレート制限を **ユーザー存在チェックの後** に入れると、存在する userId だけ 429 になる。制限は存在確認の前に、入力文字列から導いた鍵で掛ける。§2 の code id 方式ならこの問題自体が消える。
- `/device-register?token=`: `account.displayName` を返すのは token 保持者だけなので列挙にはならない。
- `onboarding/status`: token 必須。問題なし。
- `signup-begin` で email を受けなくなるので、`users.email` 重複チェックによる列挙は消える。

### 1.7 レート制限の粒度 (R5, R9)

現行の制限と、パスキーのみになった後の意味:

| 鍵 | 現行 | 問題 |
|---|---|---|
| `passkey-signup:<ip or project>` 5 / 10 分 | 経路A は **project 単位** | 旧ログイン廃止後、サービス 1 つで 10 分に 5 人しか登録できない。イベント・授業開始で確実に詰まる |
| `passkey-login:<email or ip or project>` 30 / 15 分 | usernameless は IP 単位 | 携帯キャリアの CGNAT・学校・企業 NAT で 30 人以上が同時にログインすると詰まる。経路A は project 単位で同様 |
| `passkey-device-register:<ip>` 10 / 10 分 | IP | token が単回なので総当たりの意味は無い。NAT 配下の授業で詰まる |
| recovery-code (設計) IP 15 / 分、userId 5 / 時 | userId | 本人の回復を第三者が封じられる (R5) |

推奨:

- 総当たりが不可能な単回 token (device-link, recovery, onboarding) は **IP 制限を緩める** (例 60 / 分) か、失敗回数だけを数える (成功は数えない)。
- 経路A の project 単位制限は「project の秒間 burst」(例 20 / 秒、600 / 10 分) に変え、人数の上限ではなく異常なスパイクだけを止める。
- `passkey-login` usernameless は challenge 生成の Redis 消費を抑える目的なので、IP 単位ではなく **全体の burst + IP の高い上限** にする。
- userId 単位の制限は外し、代わりに失敗を通知する (§5 の出来事に「リカバリーコードの失敗が続いた」を足す)。

### 1.8 パスキー同期の信頼境界

パスキーは iCloud Keychain / Google Password Manager で同期される。Apple ID・Google アカウントの乗っ取り = Cr のパスキーの取得になる。Cr から制御できないが、脅威モデルに「クラウド同期元の乗っ取り」を書き、`backedUp` フラグ (`credentialBackedUp`) を /devices に表示して利用者が把握できるようにする。通知の「新しい端末でのログイン」は、同期パスキーで別端末からログインした場合にも鳴るので、この脅威の検知手段になる。

---

## 2. リカバリー QR の方式

### 2.1 現案の評価

`CRRC1.<userId>.<secret>` + HMAC digest (鍵は環境変数) は、秘密値の保管としては正しい。問題は次の 3 点。

1. **userId を載せる意味が薄い**: 照合に必要なのは行の特定であり、ユーザーの特定ではない。userId を載せると (a) 画像から本人が特定できる、(b) userId 単位のレート制限が DoS になる、(c) 旧 QR が流出した後も userId は変わらないので再発行で消せない情報が残る。
2. **即時全失効** は盗難時に本人を締め出す (R1)。
3. **PNG ダウンロード** は保管場所が最も危険 (Downloads、クラウド写真)。

### 2.2 比較

| 案 | 内容 | 盗難耐性 | 本人の回復性 | UX | 実装 |
|---|---|---|---|---|---|
| A 現案 | 1 枚、単回、即時全失効 | 低 (持つ者が勝つ) | 低 (盗まれると運用者頼み) | 単純 | 小 |
| B 複数コード | 8〜10 個の単回コード、使用時はパスキー追加のみ (失効しない) | 低 (1 個漏れれば追加される) | 高 | 紙に印刷する前提。既存サービスで馴染み | 小 |
| C QR + PIN | QR の秘密値と本人が覚える 6 桁 PIN を結合して HMAC | 中 (QR だけでは不可。PIN 総当たりは回数制限) | 中 (PIN を忘れると詰む) | 覚える物が増える。「パスキーのみ」の趣旨に反する | 中 |
| D 猶予期間 + 取消 | 使用で「回復保留」に入り、既存端末と通知先へ告知。T 時間取消が無ければ確定 | 高 (本人が気づけば止まる) | 高 (本人は T 待てば回復) | 回復に待ち時間 | 中 |
| E 他端末承認のみ | QR を廃し、既存端末からの承認だけ | 最高 | 最低 (全端末喪失で詰む) | — | — |

推奨: **D を A の上に重ね、識別子を code id に替える** (A' + D)。

### 2.3 推奨仕様

- コード形式: `CRRC2.<codeId>.<secret>`。`codeId` は 16 byte 乱数 base64url、`secret` は 32 byte 乱数 base64url。行の特定は `codeId`、照合は `HMAC-SHA256(KEY, codeId || secret)`。QR に userId を載せない。
- 保存: `user_recovery_codes(id=codeId, user_id, secret_digest, created_at, used_at, revoked_at, pending_until, pending_passkey_id)`。
- 使用 (`recovery-code-begin/finish`):
  1. 一致したら UV 必須で新パスキーを登録するが、状態は **pending**。既存パスキー・端末は失効させない。
  2. `users.recovery_pending_until = now + T` を立て、§5 の通知「リカバリー QR が使われた。心当たりがなければ取り消す」を全経路 (他セッションへの relay、外部通知) に送る。
  3. T 経過後、最初の `login` (pending パスキーでの `login-finish`) の時点で確定処理 (全旧パスキー・端末失効、epoch 加算、コード使用済み化、新コード発行) をトランザクションで行う。cron を持たなくて済む。
  4. 取消: 本人の既存セッション (action proof) または通知内の **取消専用 token** (§7) で `recovery.cancel`。pending パスキーを失効し、コードを失効して再発行を促す。
- T の決め方: 通知先が 1 つ以上ある、または生きている Device Credential がある場合 **24 時間**。どちらも無い場合は誰も取り消せないので **即時**。攻撃者は本人の通知先・端末の有無を操作できないので、この分岐は安全。
- 発行時の UX:
  - 画像内に人間が読める文字列も印字する (カメラが無い環境で手入力できる)。
  - ダウンロード後、**保存した画像を読み戻す確認ステップ** を入れる (「保存したファイルを選んで確認」→ クライアントでデコードし、codeId だけをサーバーで照合)。保管できていない人を減らし、ack を実態のある記録にする。
  - ファイル名にユーザー名を入れない。「印刷して保管」を第一推奨として文言に書く。
  - 再発行は従来どおり WS + action proof。再発行時は旧 codeId を失効。
- 複数コード (B) は採らない。1 枚の方が「どれが有効か」の説明が要らず、QR 運用に合う。

---

## 3. 登録とログインの統合

### 3.1 現案の穴

- `NotAllowedError` は「無い」「取消」「タイムアウト」「UV 失敗」をまとめる。設計どおり明示操作で create に進むのは正しいが、**取消した直後の画面に「新しく始める」を同列に出す**と、別端末にアカウントを持つ人が押しやすい。「新しく始める」の前に「他の端末にアカウントがある → スマホで QR / リカバリー QR」を先に出し、create は最下段にする。
- `user.name` / `displayName` が空 (R8): 設計書 §3 は作成時 `display_name=''`。`generateRegistrationOptions` の `userName: email ?? name` が空文字になる。認証器の一覧で空欄になり、複数アカウントの区別がつかない。プレースホルダ (例 `cernere-<userId 先頭 8 桁>`) を入れ、名前設定後に Signal API で更新する。
- `users.login` は `notNull` で既定値が無いので `''` を入れることになる。unique 制約は無いが、`login` を使う画面 (`user.email ?? user.login`) が空を表示する箇所を洗う。

### 3.2 conditional mediation

`navigator.credentials.get({ mediation: "conditional" })` は Chrome 108+ / Safari 16+ / Edge で使える。`autocomplete="username webauthn"` を持つ `<input>` が必要で、画面には入力欄が無くてもよい (非表示や、名前入力欄に付ける)。`PublicKeyCredential.getClientCapabilities()` の `conditionalGet` で可否を判定する。

推奨の流れ:

1. ページ表示時に conditional get を開始 (challenge は通常の `login-begin`)。Cr のパスキーがある端末ではブラウザが候補を出す。
2. ボタン「パスキーで続ける」は modal get。
3. modal get が `NotAllowedError` → 「他の端末にある」「新しく始める」を出す。

conditional get の利点は、取消で「無い」と誤解させない点にある。欠点は conditional と modal の challenge を別に持つこと (`challengeOwner` が 2 つ)。

### 3.3 Signal API

`PublicKeyCredential.signalUnknownCredential` / `signalAllAcceptedCredentials` / `signalCurrentUserDetails` (Chrome 132+、Android。Apple は未対応) を次の場面で使う。

| 場面 | 呼び出し | 効果 |
|---|---|---|
| ログインで提示された credential が DB に無い / 失効済み | `signalUnknownCredential` | 認証器から消え、以後その候補が出ない。「失敗するから新規作成」という二重アカウントの誘因を減らす |
| 回復・パスキー削除・全端末失効の後 (ログイン成功時) | `signalAllAcceptedCredentials` | 失効したパスキーを認証器側から消す |
| 名前設定後 | `signalCurrentUserDetails` | プレースホルダ名を本名に更新 |

### 3.4 hybrid (クロスデバイス) との関係

allowCredentials 無しの modal get では、Chrome / Safari が「他のデバイスのパスキー (QR)」を出す。スマホに同期パスキーがあれば PC からそれでログインでき、その後 PC のパスキーを足せる。設計書 §4 の PC→スマホ QR は **逆方向** (PC の Windows Hello は同期されない) の穴埋めなので両方要る。画面文言で「スマホにあるならブラウザの QR で」と案内すると、二重アカウントがさらに減る。

---

## 4. 即時全廃の移行リスク

### 4.1 パスキーを持たない既存ユーザー

| 対象 | 影響 | 救済 |
|---|---|---|
| メール+パスワードのみ | ログイン不可 | 運用者回復 (本人確認の根拠はメールしか無い) |
| Google / GitHub のみ | ログイン不可 | 同上 |
| edge assertion で自動作成されたユーザー | Hub 経由は継続。Cr 直接ログインは不可 | Hub セッションから最初のパスキーを bootstrap 登録できる (step-up 免除規則) |
| admin (運用者) | パスキーが無いと `/account-recovery` の action proof を作れない | **切替前に admin 全員がパスキーを持つことを確認** (R3) |

即時全廃を前提にしたうえで足す安全策 (推奨順):

1. **移行窓 (推奨)**: 旧資格情報 (パスワード / Google / GitHub) によるログインは **「パスキー登録専用の制限セッション」** だけを発行する。この session は `passkey.register` と `onboarding` 以外の操作を拒否し (JWT の用途クレームで区別)、TTL 10 分、1 本目の登録が終わったら破棄する。これは「ログイン手段としての旧方式」を廃止しつつ、データへのアクセスは旧資格情報で一切できない状態を保つので、攻撃耐性の目的 (パスワード総当たり・OAuth 横展開でデータに触れない) を損なわない。窓は 30 日などの期限付きで 410 に切り替える。
2. 1 を採らない場合: 切替前に「パスキー 0 本のアクティブユーザー一覧」を出し、switch 前の数週間、旧ログイン直後にパスキー登録を強制するバナーを出す (いわゆる事前登録キャンペーン)。
3. いずれでも: 410 の応答本文に `/login` への案内と「回復はここ」の URL を含める。

### 4.2 composite を埋め込んだサービス

- 経路A の `auth.login` (email/password) が 410 を返すと、旧 SDK はエラー文字列を表示する (黙って止まらない)。サービスの対応は `auth_mode=passkey` (`passkeyOnly`) への切替だけでよいが、**サービスごとの作業が要る**。切替日より前に各サービスの SDK を `passkeyOnly` 既定へ上げ、サーバー 410 を「最後の保険」にする。
- `CompositeLogin` の fingerprint / 端末確認 (identity-verification) はパスワード経路専用なので、passkeyOnly では走らない。これは既存どおり。
- R9: 経路A の `passkey-signup` project 単位 5 / 10 分を切替前に直す。

### 4.3 OIDC 提供経路

- `/oidc/authorize` → Google 上流 (`oidc_request_id`) を Cr のパスキー画面へ寄せるのは正しい。RP ID は Cr の origin なので ceremony はそのまま動く。
- Cloudflare Access が Cr を IdP として使う企業 SSO では、Cr のログインがパスキーだけになる。対象ユーザー (企業メンバー) がパスキーを持たないと Hub に入れなくなる。4.1 の移行窓が無いと、edge assertion と OIDC の両方で企業側の初日が止まる。
- OIDC の `amr` に `passkey`/`user`/`hwk` 相当を出し、RP 側の MFA 推定を変えないこと (既存の AuthenticationEvidence 方針どおり)。

### 4.4 MFA (TOTP / メール OTP)

ログイン時 MFA は UV 付きパスキーで実質不要になる。設計書 §6 のとおり step-up 専用に残すなら、`mfaEnabled` 利用者のログインで MFA チャレンジを出さないよう `login-finish` の MFA 判定を外すことを実装単位に明記する (現行の `/login` は `mfaRequired` を返す)。

---

## 5. ログイン通知

### 5.1 比較

| 経路 | 到達条件 | 所有 / 運用 | レート制限 | 乗っ取り時の影響 | 評価 |
|---|---|---|---|---|---|
| 既存 WS relay (本人の他セッション) | 他端末でログイン中 | 既存機能。追加インフラ無し | 無し | 攻撃者の端末にも届く (無害) | **基底として必須**。最も即時で、「取消」の導線をそのまま置ける |
| Discord Bot DM | Bot と利用者が **共通サーバー** にいる、かつ利用者の「サーバーメンバーからの DM」が許可。両方満たさないと `Cannot send messages to this user` | LUDIARS の Bot (Cr 専用 Bot を推奨。Conexus は README のみ)。token は Vault | グローバル 50 req/s。DM 開設と未承諾 DM の多発はスパム検知で Bot が制限される。利用者単位 1 / 分の集約で十分 | Discord アカウント乗っ取りで通知が攻撃者に見える。パスキーは別なのでログインには繋がらない | LUDIARS コミュニティ (在籍者・運営) には良い。一般利用者には前提が重い |
| Google 連携アドレスへメール (SES) | Google 連携済み (`email_verified=true`) | 既存 mailer。SPF / DKIM 設定済み前提 | SES の送信上限。利用者単位 1 / 分の集約 | Google 乗っ取りで通知が見える。同上 | **主経路として推奨**。前提が「連携」だけで、Discord の DM 設定に依存しない |
| Gmail API で送信 | 送信元に LUDIARS Workspace アカウント + domain-wide delegation | Workspace 管理が要る | Gmail 送信上限 (2,000 / 日 / アカウント) | 同上 | SES と到達性に差が無く、権限が重い。採らない |
| Web Push (VAPID) | 本人が端末で購読。iOS は PWA 化が必要 | 既存無し | 無し | 攻撃者端末も購読できるが無害 | 将来の補助。スマホに「取消」ボタンを直接出せる |
| Google Chat / Firebase 等 | 利用者側の前提が合わない | — | — | — | 採らない |

### 5.2 通知すべき出来事

設計書 §7 の 4 つに次を足す。

| 出来事 | 重要度 | 補足 |
|---|---|---|
| リカバリー QR の使用 (回復保留の開始) | 最高 | **取消導線を必ず載せる** (§2) |
| 回復の確定 / 取消 | 高 | |
| リカバリーコードの失敗が連続 (例 5 回 / 時) | 中 | QR の流出・誤保管の兆候 |
| 通知先の追加・変更・削除 | 高 | **旧通知先にも送る** (通知先乗っ取りの封じ込め) |
| Google / Discord 連携の解除 | 高 | 同上 |
| 運用者回復の発行 (保留開始) | 最高 | §6 |
| 表示名の変更 | 低 | 任意 |

### 5.3 内容

載せる: 出来事、時刻 (JST と UTC)、ブラウザ / OS の概略、IP の国と市 (取得できる場合)、端末の表示名、短い出来事 ID (問い合わせ用)。

載せない: 秘密値・token・完全な IP・userId・メールアドレス・他の端末一覧。**ログインに使えるリンクは一切載せない**。

リンクの扱い: 「心当たりがない」は Cr の固定 URL (`/devices`) に飛ばし、そこでパスキーでログイン + action proof を要求する。例外は §7 の **取消専用 token** だけで、これは取消以外の何もできない。

### 5.4 封じ込め導線

- `/devices` に「この端末を失効」「全端末ログアウト」に加えて **「保留中の回復を取り消す」** と **「リカバリー QR を再発行」** を並べる。
- 取消専用 token (通知内): `recovery.cancel` だけを許可する 32 byte 乱数、digest 保存、回復保留の期間と同じ TTL、単回。乗っ取られた通知先からでも「取消」しかできないので、攻撃者が得る物は本人の回復を 1 回遅らせることだけ (運用者回復で救済可能)。
- Discord では Message Components の「取り消す」ボタンでも同じことができる。Interaction の署名 (Ed25519) を Cr が検証し、linked `discord_id` の一致で `recovery.cancel` を実行する。Interaction endpoint (公開 URL) が要るので第 2 段階。

### 5.5 通知自体の悪用

| 危険 | 対策 |
|---|---|
| 通知フィッシング (本物そっくりのメール / DM で「確認はこちら」) | テンプレートを固定し「Cr はログインリンクを送らない」を本文に常記。取消専用 token 以外のリンクはドメイン固定の `/devices` だけ |
| 通知先の乗っ取り (Google / Discord) | 通知先だけでは何もできない構造にする (5.3)。Google 乗っ取り = 同期パスキーの取得になりうるので、Google 連携解除・通知先変更を旧通知先にも送る |
| 通知先変更で本人の目を逸らす | 通知先の変更は action proof 必須 + 旧通知先へ通知 + 変更後 24 時間は旧通知先にも並行送信 |
| 通知の洪水 (攻撃者がログイン失敗を繰り返して本物を埋める) | 失敗系は集約 (1 / 時)、成功系は 1 / 分。重要度「最高」は集約しない |
| Discord DM 偽装 (Bot を名乗る別アカウント) | Bot を verified にし、本文に「DM で何も聞かない」を書く |

### 5.6 推奨案 (1 つ)

**基底 = WS relay による他セッションへの即時表示、主 = Google 連携アドレスへのメール (SES)、副 = Discord Bot DM (任意)**。

理由: WS relay は既存で、取消導線を最短で届けられる。メールは到達条件が「Google 連携」だけで、Discord のサーバー・DM 設定に依存せず、SES は既に動いている。Discord はコミュニティ利用者向けに価値があるが、到達条件を満たせない利用者が多いので主経路にできない。「Google による代行通知」を「Google が検証したアドレスへ Cr が送る」と読み替えるのが現実的で、Gmail API を使う案は権限が重く利点が無い。

---

## 6. その他の見落とし

1. **運用者回復の猶予 (R7)**: メールを集めないため、運用者の本人確認は Discord / 対面 / 所属確認などに頼る。ソーシャルエンジニアリングの標的が運用者に移る。運用者回復にも §2 と同じ保留期間 (24 時間、通知先が無ければ即時) を適用するか、admin 2 名の承認を要求する。grant 発行時に本人の既存セッションへ通知する。
2. **経路A でのリカバリー平文の中継 (R2)** は 1.2 に書いたとおり。設計書 §2 の「composite は authCode しか持たず WS 接続を前提にできないため REST で用意する」は、Cr origin のオンボーディングページを使えば不要になる。
3. **応答の `Cache-Control: no-store`**: リカバリーコード・onboarding token・device-link URL を返す全応答に付ける (kiosk 向け exchange と同じ扱い)。
4. **`signup-finish` の二重実行**: finish は GETDEL で単回だが、ネットワーク断で応答が落ちると、アカウントは作られたのにリカバリーコードを受け取れない。Cr origin の `/onboarding` で、ログイン済みセッション + 「作成から 15 分以内かつコード未 ack」なら再表示できるようにする (再表示は平文を再生成して旧 codeId を失効)。
5. **PC / スマホ判定**: クライアント判定で害は無い。ただし iPadOS の desktop UA で QR が出ても「自分のスマホで読む」は成立する。文言を「別の端末でも使えるように」に寄せると判定の誤りが気にならない。
6. **device-link の userName 表示**: `deviceRegisterBegin` が返す `account.displayName` は名前未設定だと空。1.3 の同意画面の前提として短縮 ID を返す。
7. **最初のユーザーが admin**: 旧方式廃止後、新規 DB では最初の `signup-finish` が admin になる (`count(*)=0`)。デプロイ直後の競合は既存どおりだが、パスキー登録だけで admin が取れる窓が開くので、bootstrap を `CERNERE_BOOTSTRAP_ADMIN` 等の明示に変えるのを推奨する。
8. **`backedUp` の表示**: 1.8。/devices にパスキーごとの同期有無を出す。
9. **WebAuthn の origin**: composite の埋め込み origin を expectedOrigin に合流させる現行構成では、埋め込み先サービスの XSS が Cr のパスキー ceremony を起動できる (origin が許可されているため)。パスキーのみになると、この許可 origin 一覧が Cr の認証境界そのものになる。許可 origin の追加を action proof 付きの admin 操作にし、監査ログに残す。
10. **監査ログ**: `operation_logs` にリカバリーコード・onboarding・device-link の全操作 (成功・失敗) を残すこと、平文は残さないことを明記する。

---

## 7. ログイン通知の推奨方式 (詳細)

### 7.1 構成

```
出来事 (login-finish / device-register-finish / recovery-*) 
  → auth-logger (既存の監査) 
  → LoginAlertDispatcher.enqueue(event)        … Redis list `login-alert:queue`
      ├─ 即時: sessionRegistry.broadcast(userId, {type:"login_alert", ...})   … 既存 relay 基盤
      └─ worker: 
           ├─ EmailAlertSender  (SES, 既存 mailer)   … users.login_alert_google_email
           └─ DiscordAlertSender (Bot DM)            … users.discord_id
```

- `enqueue` はログイン処理のトランザクション外で呼び、失敗してもログインを止めない。
- worker は出来事種別 × ユーザーで集約 (成功系 1 / 分、失敗系 1 / 時、「最高」は集約しない)。
- 送信結果 (成功 / 到達不可 / レート制限) を `operation_logs` に残す。

### 7.2 Google (メール) の詳細

- Google 連携 (既存 link flow) の callback で `email` と `email_verified` を取り、`login_alert_google_email` に保存。`email_verified=false` なら保存しない。
- 連携解除で列を消し、旧アドレスに「通知先が外れた」を送る。
- 送信は既存 `auth/mailer.ts` (SES)。From は固定、Reply-To 無し。テンプレートは固定文、リンクは `/devices` と取消専用 URL のみ。
- SPEC-EMAIL-OPTIONAL-MFA の「確認済みメール」を通知先に使うかは未決 (§9)。使うなら同じ列に入れ、出所を別列で持つ。

### 7.3 Discord の詳細

- Cr 専用 Bot を Discord Developer Portal に作り、token を Vault に置く。`DiscordAlertSender` は `POST /users/@me/channels` で DM channel を開き (`recipient_id = discord_id`)、`POST /channels/{id}/messages` で送る。channel id はキャッシュ。
- 到達条件を満たさない (`50007 Cannot send messages to this user`) 場合は、プロフィールの通知設定に「Discord には届きません (共通サーバーに参加し、DM を許可してください)」を表示し、メールへフォールバック。
- Bot のレート制限 (429) は `Retry-After` に従い、worker で再試行。1 ユーザー 1 分 1 通の集約を守る。
- 第 2 段階: Message Components の「取り消す」ボタン + Interaction endpoint。

### 7.4 取消専用 token

- 発行: 回復保留の開始時。32 byte 乱数、`sha256` digest を Redis に保存 (TTL = 保留期間)。
- 使用: `POST /api/auth/recovery/cancel { token }`。token のみで `recovery.cancel` を実行。応答は「取り消しました。リカバリー QR を再発行してください」。他の操作は一切できない。
- 乗っ取られた通知先からの悪用は「本人の回復を遅らせる」に限られ、運用者回復で救済できる。

---

## 8. 設計書へ入れるべき修正の一覧

| # | 節 | 修正 |
|---|---|---|
| 1 | §2 SPEC-PASSKEY-ONBOARDING | `signup-finish` は `authCode` / JWT だけを返す。`onboarding.token` と `recovery.code` を応答から外し、オンボーディングは Cr origin の `/onboarding` (ログイン済みセッション + 作成 15 分以内) で行う。composite は popup / 遷移で `/onboarding` を開く |
| 2 | §2 | onboarding の device-link 発行は 1 回。token は HttpOnly Cookie、postMessage 禁止、`Cache-Control: no-store` |
| 3 | §2 SPEC-PASSKEY-CONTINUE | conditional mediation を併用。失敗時の選択肢は「他の端末にある (ブラウザの QR / リカバリー QR)」を先に、「新しく始める」を最後に |
| 4 | §3 | `user.name` / `displayName` にプレースホルダ (`cernere-<id8>`)。名前設定後に `signalCurrentUserDetails`。`login` 列の空文字を表示する箇所の洗い出し |
| 5 | §4 SPEC-FIRST-LOGIN-PHONE-QR | スマホ側の登録を pending にし、PC 側で 2 桁確認コードの一致を承認して有効化。承認前はスマホにセッションを出さない。`/device-register` に「<名前> のアカウントに追加」の同意画面。token は fragment。表示 3 分 |
| 6 | §5 SPEC-RECOVERY-QR | 形式を `CRRC2.<codeId>.<secret>` に変更。userId を載せない。userId 単位のレート制限を廃止 |
| 7 | §5 SPEC-RECOVERY-QR-USE | 即時全失効をやめ、回復保留 (T = 24 時間、通知先も端末も無ければ即時) → 確定 / 取消に変更。取消専用 token を通知に載せる |
| 8 | §5 | 保存確認ステップ (読み戻し) を追加。画像に文字列も印字。ファイル名にユーザー名を入れない |
| 9 | §7 SPEC-LOGIN-ALERT | 基底 = WS relay、主 = Google 連携アドレスへ SES、副 = Discord DM。出来事に「回復保留の開始 / 確定 / 取消」「リカバリーコード失敗連続」「通知先変更 (旧通知先へも)」「連携解除」を追加。ログインに使えるリンクを載せない |
| 10 | §1 範囲 | 旧資格情報は「パスキー登録専用の制限セッション」だけを発行する移行窓 (期限付き) を追加。または採らない理由を明記 |
| 11 | §1 範囲 | 切替前の確認項目: admin 全員のパスキー保有、パスキー 0 本のアクティブユーザー数、composite 利用サービスの `passkeyOnly` 切替、経路A のレート制限見直し |
| 12 | §9 脅威と対策 | 「クラウド同期元 (Apple / Google) の乗っ取り」「運用者へのソーシャルエンジニアリング」「埋め込み先 origin の XSS」「通知先の乗っ取り」を追加 |
| 13 | 新節 | 運用者回復にも保留期間 (または admin 2 名承認) を適用 |
| 14 | §8 データ | `user_recovery_codes` に `pending_until`, `pending_passkey_id`。`users.recovery_pending_until`。`passkeys.status` (pending / active) または `activated_at` |
| 15 | 全体 | リカバリーコード・token・device-link URL を含む応答に `Cache-Control: no-store`。`operation_logs` に平文を残さない |
| 16 | §2.1 / §1.7 | レート制限を「失敗回数ベース + 全体 burst」に変更。project 単位の人数上限をやめる |

---

## 9. 未決事項 (推奨つき)

| 事項 | 選択肢 | 推奨 |
|---|---|---|
| 回復保留 T | 即時 / 12 h / 24 h / 72 h | **24 h**。通知先も端末も無い場合は即時 |
| 運用者回復の保留 | 無し / 保留 / 2 名承認 | 保留 (同じ 24 h 規則)。admin が 2 名以上になったら 2 名承認へ |
| 移行窓 | 即時 410 / 制限セッション 30 日 | **制限セッション 30 日**。即時 410 を選ぶなら admin 確認と 0 本ユーザー数の提示を切替条件にする |
| 通知先にメール OTP 用の確認済みメールも使うか | 使わない / 使う | 使う。出所 (google / user_verified) を列で区別し、本人が選べるようにする。「Google 経由」の意味は「Google が検証したアドレス」で十分 |
| Discord Bot の所有 | Cr 専用 / Conexus | Cr 専用で開始。`DiscordAlertSender` の差し替え口は設計書どおり |
| conditional mediation の採用 | 採る / 採らない | 採る。対応ブラウザだけで動き、非対応は modal のみ |
| Signal API | 採る / 採らない | 採る (progressive)。Apple 非対応は影響なし |
| 複数アカウントの統合機能 | 作る / 作らない | 当面作らない。作成前の案内で発生を抑える |
| 最初の admin の決め方 | `count=0` / 明示 bootstrap | 明示 bootstrap (環境変数または CLI) |
