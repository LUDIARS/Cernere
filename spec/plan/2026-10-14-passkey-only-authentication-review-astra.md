# パスキー専用認証の独立レビュー — Astra

2026-10-14 / Actio: `actio:b06fbff2-6b6e-4640-9ee6-d92b996b93e8`

対象は `E:/Document/Ars/Cernere/.wt-passkey-only/spec/plan/2026-10-14-passkey-only-authentication.md`。同 worktree の `passkey-default-authentication.md`、`spec/interface/auth-flows.md` と実装を参照した。参照 checkout HEAD は `0bea2445b16de1f916a2ab51d14ba7e7773a2dd7`（未コミットの設計文書を含む）。本成果物の作業開始 HEAD は `92c51540ae4b23b4b28fe9ee678b0698a36af482`。他方のレビューは参照していない。

本書は設計レビューであり、実装・テスト実行・サービス操作・PR 提出は行わない。依頼文の正本で指定された文書のみを変更する。以下の対策・数値は、明記した既存仕様を除き提案であり、実装済み保証ではない。

## 結論 — 重大度順の指摘

パスキーのみの通常ログインには賛成する。ただし現在案は、最も弱い入口をパスワードから「持っていれば資格情報を追加・置換できる QR」へ移す。以下を設計へ取り込んでから実装することを推奨する。

| # | 重大度 | 指摘と必要な変更 |
|---|---|---|
| R1 | Critical | 回復 QR を盗んだ者が全パスキーを置換でき、本人は通知から `/devices` に入れない。通常セッションを発行しないだけでは、新しい攻撃者キーでの直後ログインを防げない。回復待機・旧キーによる取消・運用者による凍結を設計する。 |
| R2 | High | device-link の QR は新端末の本人性を証明しない。onboarding token から発行できるため、これも実質的なアカウント取得権限。登録候補を保留し、元端末の既存キーで候補を指定して承認する。 |
| R3 | High | `/api/auth/login` 一括 410 は project/tool 認証も壊す。旧 refresh・authCode・OAuth callback・OIDC 再開状態まで方式別に移行し、入口の UI 除去だけで済ませない。 |
| R4 | High | edge assertion を残すと「人間はパスキーのみ」と一致しない。企業 SSO 例外を明示承認対象とし、個人ログインや回復への迂回を禁止する。 |
| R5 | High | 通知は任意かつ不達があり、回復防御の必須前提にできない。Discord 連携済み ID は DM 到達保証ではなく、Google メール案は連絡先を保存する。初版は到達確認付き Discord Bot DM を推奨する。 |
| R6 | High | 回復コード再発行と運用者回復の競合・失効範囲が不足。全回復経路を共通の資格情報世代で束縛し、旧コード・保留 ceremony・onboarding/device-link を同時に無効化する。 |
| R7 | Medium | userId ごとの失敗回数は他人を締め出す道具になる。IP/project・有効コード・ceremony・全体の別々の予算を持ち、未検証 ID で本人の回復枠を消費しない。 |
| R8 | Medium | get 失敗は未登録判定ではない。別端末・同期済みパスキーへの誘導と名前未設定時の credential 表示を設計する。パスキー数増加はスマホ追加成功の証明にならない。 |
| R9 | Medium | DB 更新後に Redis list へ通知を積むだけではイベントが欠落する。DB outbox、配送再試行、旧通知先への変更通知、重要イベントを捨てない集約規則が必要。 |

## 1. 攻撃耐性

### 脅威モデルと境界

想定する攻撃者は、匿名の大量リクエスト送信者、QR の写真・ダウンロード画像・ブラウザ履歴を得た者、偽サイトで正規 Cr の QR を中継する者、侵害された埋め込みサービス、通知先アカウントを奪った者、旧ログインセッションを持つ者、回復担当者を騙す者である。端末マルウェア、Cr origin の XSS、パスキー同期アカウントの侵害、Cr サーバー/管理者権限の侵害は、WebAuthn だけでは解決できない別の信頼境界として扱う。

WebAuthn の RP ID/origin 検証は維持する。ただし「攻撃者が自分の認証器で正規 origin 上にキーを作る」ことは防がない。QR を見せた本人の意思まで UV が保証するわけではない。

### device-link / onboarding

根拠: `server/src/http/passkey-handler.ts:738` の `deviceLinkCreate` は発行元の proof を検証するが、`:775` の begin は QR token を GETDEL して登録へ進み、`:824` の finish は新キー登録とトークン発行を行う。対象設計 §2 は onboarding token に同じリンク発行能力を与え、追加の proof を省略する。

攻撃例: 被害者の PC に出た QR を撮影 → 攻撃者が先に正規 Cr へアクセス → 攻撃者の UV で登録 → アカウントへログイン。15 分・単回・digest 保存は再利用と DB 漏洩対策であり、最初の窃取者を区別しない。逆方向では、攻撃者アカウントの QR を「ログイン」と偽って被害者に読ませ、そのアカウントへ被害者の情報を入力させる consent phishing も成立しうる。

推奨する変更:

- QR は即時登録権ではなく短命の pairing request とする。新端末の UV 済み公開鍵を pending として保存し、その段階では通常セッション・authCode を発行しない。
- 元端末に対象アカウント、追加先の概略、両画面で照合する番号を表示する。既存パスキーの fresh action proof を `pairingId + candidateCredentialDigest` に束縛して承認する。承認・登録確定・単回消費は同一トランザクションとし、完了後に新端末自身の assertion でログインする。
- 番号確認も人間が中継を承認すれば破られる。「サポート担当へ番号や QR を送らない」「自分の手元の端末だけ追加する」を示す。近接性をこの方式で保証すると書かない。
- 通常ログインにはブラウザのクロスデバイス認証を優先し、独自の追加登録 QR と用途・画面・名称を区別する。既存キーによる認証と新キー追加は別操作である。
- onboarding token をプロフィール用と pairing 用に分ける。プロフィールは設定完了後に失効、pairing は元ブラウザのランダム nonce と元キー ID・epoch・期限に束縛する。新しいリンクで前の未使用リンクを失効させ、回数制限を原子的に更新する。token 単独で承認できないことが重要。
- 15 分の一般 token とは別に QR の表示期限は短くする（提案 2〜5 分）。grant の期限を ceremony に引き継ぐ。status は全パスキー数ではなく当該 pairing の状態を返す。
- device-link は URL query から fragment へ移し、読み込み直後に履歴から除去する。POST body で送信し、ログ・APM・エラー・Referer・解析タグへ含めない。登録/回復ページは third-party script を置かず CSP、frame-ancestors、no-store、Referrer-Policy を設定する。fragment でも同じページの悪意ある JS には読める。

### 列挙・レート制限・二重アカウント

`auth/passkey-rate-limit.ts` は信頼できる projectKey を優先しており、この考え方は再利用する。payload の IP や userId を信用して予算を割り当てない。REST の IP も信頼済みプロキシからだけ採用する。

begin と finish の両方に IP/project ごとの制限、同時 ceremony 数・JSON/attestation サイズ・総 CPU 予算を設ける。回復の形式/存在/使用済みエラーは一律にし、定数時間 digest 比較だけで DB lookup の時間差まで消えたとは扱わない。ランダム ID による Redis キー増殖を制限する。アカウント単位の小さな予算は秘密値検証後の有効要求へ適用し、不正な userId 指定だけで本人を毎時 5 回枠から追い出さない。NAT 利用者や大規模 project の共有枠は計測に基づき調整する。

メールも中央本人 ID も収集しないため、同じ人の二重アカウントを完全には識別できない。UA・端末 fingerprint・表示名・通知先の一致で自動統合しない。後日の統合を設けるなら両アカウントの fresh proof とデータ衝突処理を別途要求する。

## 2. リカバリー QR の方式

### 形式・鍵管理

UDID を端末固有 ID とせず、ユーザー識別子と独立乱数に置き換える解釈は妥当。ただし「ハッシュを埋める」ではなく「QR 内の秘密値そのものが回復資格情報」であると説明する。UUID は秘密ではないが、QR 写真・印刷物を他サービスの userId と結び付けられる。推奨形式は `CRRC1.<randomRecoveryId>.<secret>`。DB で opaque ID から user を解決し、QR に恒久的 userId を載せない。userId 形式を維持しても 256 bit secret の強度は落ちないが、識別子露出は残る。

HMAC-SHA256 と 32 byte CSPRNG secret は採用可能。HMAC 入力は version、purpose、recoveryId、userId、secret を固定長または長さ付きでエンコードし、用途を分離する。`userId || secret` の曖昧な連結表記を実装仕様にしない。鍵 ID を行に持ち、旧鍵照合期限・鍵漏洩時の一括失効と再発行を決める。鍵は DB と別の秘密管理領域へ置く。

ランダム 256 bit secret は無鍵ハッシュでも総当たりが現実的でない。HMAC の価値は防御層の追加であり、コピーされた QR のオンライン使用防止ではない。「DB だけでは照合できない」はサーバー鍵が別に保護される前提で書く。

### 単回使用・失効・競合

単回使用と回復確定時の全キー/Device Credential/refresh 失効は妥当。user → code のロック順、同一トランザクション、通常ログインを別にする方針も再利用する。ただし以下が不足する。

- begin 時の正しいコードだけで複数 ceremony を無制限に発行しない。コード ID・対象 epoch・回復世代・有効期限を全 pending に保存し、finish 内で再確認する。
- QR 再発行と finish の競合を同じ user ロックで直列化する。再発行で既存 pending も無効にする。有効行の一意索引は補助であり、世代検証の代用ではない。
- 運用者回復でも旧 QR を無効化する。既存 `auth/registration-grant.ts:84` の `completeRecovery` は新設予定のコード表を扱わないため、再利用時にこの連動を足す。さもないと一度救済しても盗まれた旧 QR で再侵入できる。
- 通信断で新しい QR の一度きり応答を失った場合、新キーでログインして fresh proof 付き再発行へ進める。失われた平文のサーバー再表示はしない。再発行により前の紙は無効と明示する。
- 全端末失効と回復コード失効は別の操作である。通常のログアウトで非常用 QR を勝手に消さない一方、侵害対応の「アカウント保護」では回復コード・link grant・通知先変更 pending まで対象にする。

### 待機・取消の推奨

**提案は「単一の回復 QR + 24 時間の回復待機」**。24 時間は標準が要求する値ではなく、運用で決定する初期候補である。

1. QR 検証と新キーの UV 完了で回復要求を pending にする。新キーはまだ通常認証に使えず、旧キーは維持する。通知先のスナップショットと outbox を同じ DB 更新で記録する。
2. 待機中は、要求作成前から有効な旧キーの fresh proof で取消可能とする。新 pending キーや QR 単独では取消・即時承認・通知先変更を認めない。
3. 時間満了後も自動ログインさせず、新キーの assertion で保有を再証明して確定する。期限・未取消・コード世代・対象 epoch を再確認し、全旧キーと全セッションを失効する。旧キーで取消できた場合は盗難 QR も失効させる。
4. 旧キーを全て失った本人は運用者の別窓口へ申告できる。運用者は本人確認後に pending を凍結し、一般セッション発行と分離して対応する。通知先だけによる本人認定はしない。
5. 通知なし/不達では待機だけで検知を保証できない。一般利用者は残余リスクを表示し、管理者など高権限者は独立した第二パスキーを必須とし、QR 単独の自動回復は認めず運用者確認を要求する。

通知内の取消 token に自動失効権を持たせると、通知先侵害が Cr の DoS 権になる。初版では通知リンクは固定の安全画面への入口だけにし、旧キーまたは運用者確認を用いる。今の「全キー置換後に `/devices` + action proof」で本人が止められるという説明は削除する。

### 保管 UX と代替案

| 案 | 利点 | 危険・判断 |
|---|---|---|
| 単一 QR、即時回復 | 最も簡単 | 写真1枚で即時乗っ取り。現案のままは非推奨 |
| 単一 QR、待機付き | 紙の操作は同じで取消機会がある | 不達時の検知保証はない。推奨、権限別に制約 |
| 複数の単回コード | 紛失・消費後の予備になる | 同じ紙を盗まれると全部漏れる。1件利用時に全セットを失効/再発行する規則が必要。初版は複雑さに見合わない |
| QR + 別保管 PIN | QR だけの漏洩に追加障壁 | 短い PIN は低エントロピーで忘却・総当たり・サポート負担がある。同じ紙なら無意味。採用時はオンライン試行制限とメモリ困難 KDF を別途設計 |
| 独立した第二パスキー/物理キー | bearer QR を使う場面を減らせる | 費用・保管・同じ同期アカウントへの依存。高権限ユーザーに推奨 |

ダウンロード押下は保存成功・別媒体保管の証拠ではない。保存後の読み取り確認を任意で提供し、「端末と同じクラウド写真庫だけに置かない」「共有プリンター・チャットへ送らない」「この紙を撮った人も回復できる」を表示する。画像には秘密値を含むこと、発行日と版だけを記し、氏名・メール・userId を不要に印字しない。カメラ非対応時はローカル画像デコードと手入力を用意し、外部 QR 生成/解析サービスを使わない。

## 3. 登録とログインの統合

get → 明示 create は採用してよい。`NotAllowedError` を「アカウントなし」と表示せず、再試行・別端末のパスキー・回復・新しく始めるを提示する。通信断、Origin/RP 設定不備、ブラウザ非対応で create を誘導しない。既存 `usePasskeyLogin.ts` はユーザー取消とその他のエラーを区別するため再利用候補となる。

conditional mediation は対応確認後の補助 UI とする。自動処理が完了しないまま create/明示 get と競合しないよう AbortController で旧要求を止める。名前もメールも聞かない入口ではオートフィル用入力を追加する価値が小さく、最初は明示ボタンで十分である。Signal API は認証後の `signalCurrentUserDetails` で後入力名を反映し、`signalAllAcceptedCredentials` で有効キーを通知できる。未認証で全 ID リストを返さず、`signalUnknownCredential` は確実に不明と確認した credential に限る。機能未対応でも通常認証は成立させる。これらは本人同定や二重アカウント防止の API ではない。[WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)

既存 signup は `userName: email ?? name`、`userDisplayName: name` を渡す。名前後入力へ変える際、空の DB 名をそのまま認証器へ渡さず「Cernere アカウント + ランダムな短い表示識別子」等の暫定値を用意する。表示名変更で不変の user handle を変えない。Signal 非対応認証器には旧表示が残り得ると扱う。

PC/スマホ判定は表示ヒントに限る。スマホでも機種変更・紛失に備える導線はプロフィールから使えるようにする。同じ同期パスキーが別端末で使われても本数は増えないし、UA や credential ID から物理的スマホの所有を証明できない。オンボーディング完了は「対象 pairing が承認・登録された」で判定する。

composite の authCode を発行してから 15 分のオンボーディングを行うと、既存の 60 秒 TTL と整合しない。完了時に通常の再認証/セッション確認で authCode を発行する設計にし、秘密の QR/onboarding token を親ページへ postMessage しない。名前入力やダウンロード強制をセキュリティ境界にするならサーバー状態でも制御し、単なる案内なら UI 制約だと明記する。

## 4. 即時全廃の移行リスク

「即時全廃」は旧方式をログイン fallback として残さないことと解釈する。事前の移行準備・影響確認を省く理由にはならない。

| 対象 | 根拠と変更提案 |
|---|---|
| 旧ユーザー | 有効な discoverable passkey の有無、管理者、通知未設定者の人数を集計する。切替前のキー追加案内と運用者回復能力を release gate にする。表示名だけで救済対象を特定しない |
| REST login | `http/auth-handler.ts:127` の login は `client_credentials` と `project_credentials` を先に分岐する。これらを維持して、人間の password 分岐だけ 410 にする。guest/project WS も action と主体の対応表で検査する |
| 旧セッション | password/OAuth 由来の refresh、authCode、legacy session Cookie、MFA pending が切替後も新トークンを発行できるかを決める。強い境界を求める本件では再認証を要求する。由来不明は旧方式扱い。epoch 一括更新は passkey session も落ちるので影響と運用時間を明示する |
| OAuth link | `oauth-handler.ts:445` 以降は callback の後半に通常ログインがある。有効な provider-bound link grant のみ成功させ、期限切れ・旧形式・不明 state は拒否する。通常 OAuth login state は開始済みでも通さない |
| 連携先の解除 | Google/GitHub を login method と数える既存 `auth/login-methods.ts` と unlink ガードを見直す。今後のログイン能力は有効パスキーで判定し、通知先連携とは分離する |
| composite | 旧 SDK の 410 表示だけでは利用不能になる。利用サービス一覧・SDK/API 版・同一 origin/popup/redirect の対応を切替前に揃える。`displayName:null` を受けられる契約も更新する |
| OIDC | 上流 Google を削るだけで Cr の RP 向け OIDC を削らない。request ID に結び付いた client、redirect_uri、state、nonce、PKCE、scope、consent を保ったままパスキーへ遷移する。max_age / prompt=login は fresh authentication で判定し、refresh や名前入力で auth_time を更新しない |
| OIDC 非対話要求 | prompt=none で登録画面を出さず、認証がなければ仕様上の login_required、必要な同意がなければ consent_required とする。企業 acr を要求されたら一般パスキー UV だけで所属・企業保証を偽装しない |
| 下流失効 | 元設計が明記する通り、オフライン検証済み ID token/PASETO や Cloudflare Cookie まで Cr の失効で即時消えない。サービスごとの有効期限・失効反映時間を契約化する |

OIDC の認証要求に関する根拠は [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)。切替失敗時はメンテナンス/修正版への rollback を用意し、無断でパスワード認証を再開する手順にしない。パスキー未保有の既存ユーザーを同名の新規アカウントへ誘導してはならない。

edge assertion は「上流で人間を認証して Cr セッションを発行する入口」であり、パスキーのみの例外である。残すなら企業限定 issuer/audience/project/tenant、安定した subject による identity mapping、offboarding、認証強度の明示が必要。email 一致だけの個人アカウント自動 link は避ける。例外の承認前は廃止対象外と断定しない。

## 5. ログイン通知の比較

| 方式 | 実現方法・条件 | 評価 |
|---|---|---|
| Discord Bot DM | identify による連携 ID に対し Bot token で DM channel を作成して送信。利用者が通知を有効化して試験 DM を受け取る | メール不要の方針に最も合う。共通サーバー・DM 設定・ブロック等で不達になるため検知保証は不可。初版の推奨 |
| Google の確認済みメールへ SES/SMTP | Google identity の sub と email_verified を検証し、同意済みアドレスへ既存 mailer で送る | 実装再利用しやすいが送信者は Cr。Google が Cr のセキュリティ通知を代行するわけではなく、メールの取得・保存が必要 |
| Gmail API | Cr 所有の送信アカウントへ OAuth を許可し、users.messages.send でメール送信 | SES の代替配送。トークン保管・更新・送信制限の運用が増える。利用者の gmail.send を取得して本人に自己送信する設計は権限過剰 |
| Google Cross-Account Protection | Google から Cr がセキュリティイベントを受信する | Cr の任意ログインイベントをユーザーへ Google 警告として送る API ではない。通知の代替にしない |

Discord の identify 連携だけで Bot DM が許可されるとは扱わない。公式資料も共通サーバーの欠如、DM 無効、ブロック等を不達理由に挙げる。対象設計の「共通サーバーにいる**か** DM を許可」は到達条件として不十分である。ユーザー操作を契機に DM channel を作り、実際の試験送信と本人の確認で有効化する。[Discord DM 不達理由](https://support.discord.com/hc/en-us/articles/360060145013-Why-isn-t-my-DM-going-through)、[Create DM](https://docs.discord.com/developers/resources/user#create-dm)

Google 連携は sub を本人の安定識別子に使い、email をアカウント結合キーにしない。Google アカウントは必ずしも Gmail アドレスではない。通知先変更時は再確認し、Google 連携の成功をメール配送成功と同一視しない。[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)

Gmail API の gmail.send は送信権限で sensitive scope に分類される。必要ならサービス所有の送信アカウントだけに限定する。Google の Cross-Account Protection は Google 発のイベントを Cr が受けて対処する仕組みであり、本件の outbound alert と方向が逆である。[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)、[messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)、[Cross-Account Protection](https://developers.google.com/identity/protocols/risc)

## 6. その他の見落とし

- **メール OTP の権限**: 「MFA 用レガシー経路」が passkey action proof を置き換えるなら、資格情報管理をフィッシング可能な OTP へ弱める。追加条件としてのみ使い、QR 再発行・キー追加・通知先変更・回復取消の UV を代替しない。
- **初回 admin 自動割当**: `finalizePasskeySignup` は users 件数ゼロで admin を選び、その判定は挿入トランザクション外にある。新設環境では公開 signup の先着者/並行要求に管理権限が渡る。公開前の明示 bootstrap と排他を release gate にする。本レビューでは再現テストは行っていない。
- **XSS と埋め込み先**: QR 平文を response に返せば、同じ origin の JS は読める。復旧秘密は Cr の専用トップレベル画面だけで扱い、埋め込みサービスには authCode 以外を渡さない。広い RP ID と origin 許可リストは全許可 origin の侵害リスクを共有するため、安易に追加しない。
- **同期パスキーの意味**: 新 credential や新 Device Credential は物理的な新端末と同義ではない。通知文は「新しいブラウザのセッション」等の観測事実に寄せる。同期アカウント侵害による既存キー利用もあり、キー追加通知だけでは検出できない。
- **監査**: QR、onboarding token、device-link、authCode、OAuth code、Cookie を汎用パラメータログへ記録しない。成功/失敗理由は内部で区別し、外部応答は列挙耐性を維持する。操作履歴へのアクセス権と保存期限も定める。
- **運用者回復**: 表示名・メール・Discord ID を知っているだけで本人と認めない。高権限アカウントは二者承認と監査を推奨する。回復窓口の本人確認能力がない状態で旧方式だけ先に止めない。

## ログイン通知の推奨方式の詳細

### 所有・連携・到達確認

初版は **LUDIARS 所有の Cr 専用 Discord Bot による opt-in DM** とする。運用責任者、Bot token の保管・ローテーション、障害連絡先を定める。将来 Conexus に移す場合もイベント契約と配送実装を分離し、現時点で README だけのサービスに配送責任を置かない。

既存 `auth/oauth-link.ts`、provider-bound grant、state Cookie、fresh action proof を再利用する。通知有効化はアカウント link と別の同意として記録する。試験 DM の確認番号を、ログイン中の Cr 設定画面で入力して到達確認する。番号は短命・試行回数制限付きで、ログインや回復には利用不可。確認できない場合は「未確認/停止」を表示し、通知済み扱いしない。

`POST /users/@me/channels {recipient_id}` → `POST /channels/{id}/messages` を Bot として呼ぶ。ユーザー OAuth token で DM を送らず、受信 message content の収集は不要。通知先 ID も個人に紐付くデータなので「連絡先を一切集めない」とは表現しない。

### 配送とイベント

DB transaction で security event と outbox を記録し、worker が送信する。worker は lease/ack・指数 backoff・jitter・最大保持期限・dead letter を持つ。少なくとも一度の配送を前提に eventId で重複を減らし、送信直後のクラッシュによる重複の可能性は残る。送信失敗でログインを止めず、障害を監査・管理画面へ出す。

Discord の bucket/global 制限と Retry-After をレスポンスから読み、固定の送信数を根拠にせず 429 を再試行する。403 等の恒久エラーは連打せず通知先を degraded にする。message ID の取得は API 受付の証拠であり本人が読んだ証拠ではない。[Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)

| 出来事 | 通知方針 |
|---|---|
| 新規セッション確立 | 認証経路を横断して送る。refresh のたびには送らない。同一イベントの再送と短時間の通常通知だけ集約 |
| 新パスキー追加・削除 | 即時。pending pairing 開始と承認完了を区別する |
| 回復の要求・取消・確定、QR 再発行 | 即時の重要通知。待機期限と次の操作を示す。種類単位で一律 1 分間捨てない |
| 運用者回復・全セッション失効 | 即時。事実と運用窓口を示す |
| 通知先の追加・変更・解除・通知停止 | 変更前の確認済み先へ通知し、新しい先も確認する。攻撃者が変更してから発生したイベントを新しい先にだけ送る穴を防ぐ |
| 大量の失敗ログイン | リクエストごとに送らない。集約した内部検知と必要な警告に限定し、通知爆撃を防ぐ |

元の `loginFinish` は Device Credential 分岐で早期 return し、従来の `logUserLogin` はその後にある。既存ログを唯一の通知フックにすると経路を取りこぼす。REST/composite/device-register/回復の成功トランザクションから共通イベントを生成する。

通知設定は version を持ち、重要イベント発生時の宛先と変更前宛先を保存期限付きで保持する。unlink 後の一般通知は止める一方、解除そのものの安全通知を旧宛先へ1回送る方針を利用者に示す。配送キューへ秘密値は入れない。

### 内容と「自分ではない」

出来事、UTC の発生時刻と利用者向け時差表示、ブラウザ/OS の概略、信頼できるときだけ国、短い非秘密イベント番号、Cr の固定 URL を送る。完全な IP、精密位置、メール、userId、秘密値、QR、セッション/認証コードは載せない。UA と表示名は未信頼文字列として escape し、Discord の allowed_mentions を無効化する。位置・UA は参考情報で本人確認の根拠にしない。

固定 URL をブラウザで開き、Cr 内で対象イベントを認証後に確認する。GET やリンクプレビューで失効を実行しない。通常の不正ログインは fresh proof による対象セッション失効、侵害疑いでは全セッション・攻撃者キー・回復コード・保留 link を一括確認する「アカウント保護」へ進む。単なる全端末ログアウトでは攻撃者の追加済みパスキーを消せないことを明記する。

回復 pending は §2 の旧キーによる取消へ誘導する。確定後に旧キーを全て失った人には運用者窓口を示す。Discord ボタンや通知先の OAuth ログインだけで Cr の復旧・キー登録・停止解除を許さない。通知先侵害による乗っ取り経路を作らず、通知の隠蔽・偽通知という残余リスクを扱う。

## 設計書へ入れるべき修正の一覧

| 対象節 | 修正と受入観点（今後の実装で検証する） |
|---|---|
| §1 範囲 | login の grant_type 分岐を残す。旧 REST/guest/project WS/OAuth callback/refresh/authCode を経路表で塞ぎ、project/tool の正常経路を対で検証する |
| §1 既存ユーザー | 影響人数・管理者回復・SDK 切替を release gate に昇格。edge assertion 例外は未承認と明記する |
| §2 onboarding | profile と pairing の権限分離。元ブラウザ・元キー・epoch の束縛、原子的回数制限、完了時失効を追加する |
| §3 名前 | 認証器の暫定表示名、user handle 不変、null を受ける下流契約、authCode 発行タイミングを決める |
| §4 QR | 新キー保留→元端末の候補指定承認→確定へ変更。QR 窃取・候補すり替え・二重承認・期限/epoch 競合を拒否する |
| §5 回復 | opaque recoveryId、HMAC の用途分離・鍵 ID、pending 世代、再発行/運用者回復時の旧 QR 失効、待機・取消・応答消失時 UX を追加する |
| §5 制限 | 匿名攻撃者が任意 userId の枠を使い切れない設計、begin/finish/全体予算を追加する |
| §6 メール | OTP は fresh passkey proof の代用にしない。通知の Google メール保存とは目的・同意を分ける |
| §7 通知 | Discord 到達確認、outbox、旧宛先への変更通知、重要通知の欠落防止、通常ログアウトではキーが残ることを追加する |
| §8 データ | recovery generation/pending/cancelled/activated、key_id、通知先確認状態・version、outbox を追加する。migration 番号は実装時の既存最大値と照合する |
| §9 脅威 | QR 中継、XSS、同期アカウント侵害、通知不達、既存セッション迂回、運用者への詐称、失効の下流境界を追加する |

再利用は `registration-grant` のロック/失効処理、`action-proof` の用途束縛、`oauth-link` の provider-bound grant、`passkey-rate-limit` の project 境界、composite popup の source/origin 確認を優先する。ただし operator grant と自己回復 QR は発行主体が違うため同じ資格情報型にはしない。mailer は Google メール案を採用する場合に限る。Conexus を実装済み配送基盤として扱う案、既存 `device-link` を無変更で onboarding に公開する案は採用しない。

想定する回帰検証は、回復 finish と取消/再発行/運用者回復の競合、旧 token/epoch の拒否、QR 窃取者単独の追加拒否、callback 失効時の通常ログインへの非転落、project/tool 維持、OIDC request の保持、composite の秘密非転送、通知 worker クラッシュ/429/403/宛先変更を含む。本レビューでは実行せず、Augur 契約やテスト実装も追加していない。実装を開始する担当がこれらを契約・テスト計画へ落とす。

## 未決事項（推奨つき）

| 未決 | 推奨 |
|---|---|
| edge assertion の例外 | 「企業限定の明示例外」として人間が決めるまでは既定許可にしない |
| 回復待機の長さ | 初期案24時間。高権限は自動確定せず運用者確認。通知なしのリスク受容を明記する |
| 回復凍結時の本人確認 | 管理者二者承認・既存の登録情報/別窓口を組み合わせる。通知先所持だけでは不十分 |
| 連絡先を収集しない意味 | 初回入力不要と一切保存しないを区別する。初版 Discord の任意 ID 保存を明示し、Google メールは別途同意する追加案に留める |
| Discord Bot 所有者と対象サーバー | Cr 専用 Bot、LUDIARS 管理。参加要件と試験 DM を利用者に提示。到達しない利用者を安全保証済みにしない |
| 旧セッション切替時点 | 旧方式由来は切替時再認証。由来不明も拒否。passkey 保有者の再ログインと回復窓口を先に準備する |
| 「スマホのパスキー」達成条件 | 物理端末認定ではなく、承認された追加 credential または既存パスキーによる別ブラウザ利用と定義する |

## 参照・確認範囲

ローカル根拠は冒頭の参照 worktree 内の対象設計、端末セッション設計、auth-flows、`server/src/http/{passkey-handler,passkey-recovery-handler,oauth-handler,auth-handler}.ts`、`server/src/auth/{registration-grant,passkey-rate-limit,mailer}.ts`、`packages/composite/src/ui/{CompositeLogin,CompositePasskeyPopup}.tsx` と `usePasskeyLogin.ts`。行番号は参照時点の目安であり、他方のレビューおよびその結論は未参照。

外部根拠は各論に記載した公式文書を 2026-10-14 に確認した。ブラウザ/OS ごとの実機対応、Discord Bot の実配送、既存利用者の件数、運用者本人確認の実効性は未検証であり、実装/移行担当の確認事項である。
