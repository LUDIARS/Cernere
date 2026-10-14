# Cernere 登録許可制の設計案 (Astra)

2026-10-14。Actio 参照: `actio:ef66a8bc-fe15-477d-85d4-d085c3f50f5b`。
本書は設計提案であり、承認状態の実装・テスト・サービス起動は行わない。

## 結論

**A: Cr 全体の許可制を推奨する。** パスキー登録は即時に成立させるが、新規ユーザーは `pending` とし、Cr 内の本人用設定だけを使える。Cr の system admin が許可した `active` のみ、他人の公開データとサービスログインへ進める。許可は既存の組織ロール・共有設定・サービス権限を代替しない。`locked` は全サービスに優先する停止状態とする。

pending には外部向け authCode・user×project token・OIDC token を一切発行しない。UI の制限だけでなく、発行・交換・API 実行・イベント配送の境界で現在の状態を検証する。承認のないサービス主体が任意の userId を指定できる経路は別に締める。ロックは Cr だけで完結せず、サービス側の独自セッションとオフライン検証を含む失効契約が必要である。

### 調査基準

- 読み取り対象: `E:/Document/Ars/Cernere/.wt-passkey-only`、branch `feat/passkey-only-auth`、調査時 HEAD `d60f276c93abd5baaf9de2fd87c2aca9f911b78e`。以下のパスはこの worktree 相対。調査時の status は `lib/lapilli` の未追跡内容表示のみ。別 worktree の変更はしていない。
- 前提設計: `spec/plan/2026-10-14-passkey-only-authentication.md`。DB リセットは人間が行う前提で、既存ユーザーの移行は不要。
- 古い共通説明の「JWT」「同一ユーザー relay 限定」だけで安全と判断しない。現コードの user×project token は PASETO、relay は任意 user/session 宛ての分岐を持つ。
- 下流サービス本体は調査対象外。下流が現在すでに失効契約を満たすとは主張しない。実装時は接続サービス単位の適合確認をリリース条件にする。

## 1. 他人のデータとサービスへ届く経路

表の「現状」はコード上の観察、「対策」は提案。サービス主体の操作を人間の直接操作と混同しない。

| ID | ファイル・関数 / 入口 | 現状の境界と到達先 | pending / locked 対策 |
|---|---|---|---|
| R1 | `server/src/commands.ts` `dispatch`, `userCmd` | Redis session / logged_in 確認後、`user.get` は指定 ID の email・role 等、`search` は email を含む列挙、`get_profile` は公開プロフィールを返す。各処理に承認状態はない | pending は self の明示 allowlist のみ。検索は禁止。active にも email を公開扱いしない投影と閲覧関係チェックが必要 |
| R2 | 同 `organizationCmd`, `memberCmd`, `orgProjectCmd` | `organization.get/presence`, `member.list`, `org_project.list` は指定 orgId から取得し、当該分岐に所属確認がない。member.list は email を返す。変更は org role 等で制限 | pending は一覧・取得・参加・招待受諾を拒否。active も所属検査を追加。管理者による pending の先行 membership 追加も拒否 |
| R3 | 同 `projectDefCmd`, `managedProjectCmd` | project 定義・サービス一覧、本人 project data、open URL、管理設定への入口。管理操作の既存 admin 検査とは別に利用承認が必要 | pending に一覧や open を公開しない。本人 profile と project data を同一視しない。管理者も active 必須 |
| R4 | `server/src/ws/handler.ts` `handleWsMessage`; `ws/session-registry.ts` `SessionRegistry.relay`, `send`; `ws/events.ts` `pushOrgEvent`, `getOrgPresence`, `notifyPresenceChange` | relay は command dispatcher 外。broadcast は本人だが user/session target は宛先を指定できる。イベントは受信側 session を再検査するが承認状態の検査はない | pending の汎用 relay は本人宛ても拒否。システム発の本人セキュリティ通知のみ別経路で許可。active も宛先の関係・権限を検査。受信・presence・購読復帰にも状態検査 |
| R5 | `server/src/ws/project-dispatch.ts` `dispatchProjectCommand`; `project/service.ts` `getUserColumns`, `setUserData`, `deleteUserColumns`; `project/user-data-query.ts` `listUserData` | project WS は projectKey を固定するが userId は payload。列挙も可能。「自己 project」は「本人のデータ」ではない | ユーザー代理要求には検証済み actor を必須化し、actor active と対象行権限を検査。機械バッチは明示 scope と対象集合で区別し、通常結果から非 active を除外 |
| R6 | `project/data-sharing.ts` `getSharedUserColumns`, `setSharedUserColumns`, `resolveSharedColumnNames` | 他 project の grant・列・module 範囲を検査する。これだけでは呼び出した人の承認・閲覧権限は表現しない | R5 の actor 判定を共有の前にも要求。既存 grant と状態を AND。空列・不許可・欠落 actor から全列へ広げない |
| R7 | `project/profile-service.ts` `getServiceProfile`, `updateServiceProfile`; `project/profile-access.ts` `resolveProfileAccess`; `project/identity-claims.ts` `getIdentityClaims`, `resolveUserByClaim` | profile は許可ユーザー・項目、identity は宣言 claim の境界。ユーザー識別・通知先 ID の取得経路 | 機械主体の対象 active と scope、代理 actor の active を検査。pending の通知連携は Cr 内部の本人操作に限定し、この経路を流用しない |
| R8 | `http/identity-roster-handler.ts` `handleIdentityRosterRoute`; `http/export-auth.ts` `requireExportAuth` | roster は admin または有効な project credential。facility の userId・hint・role を返す。project principal と facility の結び付けはこの handler にない | admin active、機械側に施設別明示 grant。名簿対象から pending/locked を除外。キャッシュ済み名簿への失効伝播も必要 |
| R9 | `http/passkey-handler.ts` `exportPasskeys`; `http/project-schema-handler.ts` `exportProjectSchemas`; `http/export-auth.ts` `requireExportAuth` | passkey export と schema export は共通認可。schema は定義のみで user data ではない。公開鍵も外部照合を可能にする | passkey export は利用目的・project・facility を限定し非 active を除外。schema export の機械用途は維持。包括的 project credential を本人承認の代替にしない |
| R10 | `auth/auth-code.ts` `issueAuthCode`, `issueAuthCodeForUserId`; `http/auth-handler.ts` `compositeSessionCode`, `exchange`; `http/auth-code-exchange-handler.ts` `handleAuthCodeExchange` | authCode 内に access/refresh pair を保存 (60 秒)。silent SSO、一般 exchange、kiosk 用交換がある。一般 exchange は GETDEL 後 verifyToken | 発行前・両交換口で active 再確認。承認前の code・refresh row を作らない。ロック前発行 code も交換不可 |
| R11 | `http/passkey-handler.ts` `executePasskeyCompositeAction`; `ws/composite-auth.ts`; `auth/auth-session.ts` `createAuthSession`, `getAuthSession`; `packages/composite/src/composite.ts` `CernereComposite.exchange`; `ui/CompositePasskeyPopup.tsx` `CompositePasskeyPopup` (packages/composite/src 配下) | REST / project WS / popup から認証完了とサービス側ログインへ到達する。本人確認後の結果が外部へ渡る | 認証成功と外部利用可を分離。pending は Cr onboarding へ留め、SDK に approval_required を返す。fingerprint・MFA 完了による昇格も禁止 |
| R12 | `http/auth-handler.ts` `projectUserToken`; `project/service.ts` `issueProjectOpenUrl`, `ensureUserProjectRow`; `auth/paseto.ts` の署名処理 | user×project は 15 分 PASETO。project の有効性と user の存在を確認。open 時などに project_data 空行を確保 | 発行・open・行確保前に active。登録時には全サービス行を作らない。承認後の初回サービス利用時だけ冪等に確保 |
| R13 | `oidc/provider.ts` `approveAuthorization`, `exchangeToken`, `userinfo` | code 交換と userinfo は session 世代・client・認証条件を確認。ID token を受けた RP の独自 session は Cr の外 | 同意・交換・userinfo で active。ID token だけで長期 session を作る RP は適合不可。pending には外部 claims を出さない |
| R14 | `ws/project-dispatch.ts` `auth.edge_assertion` / enterprise 分岐; `auth/edge-assertion.ts` `authenticateEdgeAssertion`; `enterprise/sessions.ts` `enterpriseProjectCommand` | 企業向け例外でも authCode / project data / OIDC へ接続する | CF 認証・組織所属・企業認証を全体承認と同一視しない。既定 pending、明示した企業自動承認ポリシーだけ将来の例外。locked は例外なく拒否 |
| R15 | `project/relay-service.ts` `requestPeer`, `verifyChallenge`; project-dispatch の managed_relay | Cr は peer 接続仲介後のデータ経路に入らない。challenge / opt-out の検査だけでは継続接続を停止できない | userId・状態世代を challenge に束縛し発行・消費時に検査。peer 側の継続接続にも認可更新と切断契約 |
| R16 | `http/auth-handler.ts` `refresh`, `verify`, `toolLogin`, `projectLogin`, `serviceToken`; `auth/user-session-state.ts` `assertUserSessionCurrent` | user token は authEpoch / role / device を確認。tool / project / service credential は別 principal | pending の Cr self refresh のみ許す。locked の user 再認証・refresh は拒否。機械 credential 自体は人間状態と分離し、代理要求・owner 由来権限に明示 policy を適用 |
| R17 | project-dispatch の OAuth token storage / voluptas_survey; `project/service.ts` `getOAuthToken`, `listOAuthTokens` | project credential 経由で指定利用者の外部 token やサービス専用データへ届く | R5 と同じ主体分類。locked ユーザーの代理ジョブと token 取得を停止。保全・削除処理だけ専用 scope と監査で許可 |

**既存境界の補修は A/B どちらでも必要。** 特に R1/R2/R4 は active を得た攻撃者にも残る。許可制でこの不足を正当化しない。R8/R9 の機械 export が漏洩すると pending の制限を迂回できるため、ブラウザから使える共通 service credential を配布しない。

## 2. 案の比較

| 観点 | A: 全体許可制 (推奨) | B: サービスごとの許可 |
|---|---|---|
| 登録直後 | Cr 本人設定のみ | Cr 本人設定のみ。Cr 内他人閲覧にも独立 grant が必要 |
| 判定 | global active AND 既存リソース権限 | global 非 locked AND Cr-directory grant / project grant AND 既存権限 |
| 長所 | 判断・説明・失効が一貫。承認漏れの入口を減らす | サービス別責任者が審査でき、1 サービスの許可を他へ広げない |
| 欠点 | Cr admin に審査が集中。承認後のサービス範囲が広い | 未申請/審査中/拒否/失効の project 行、横断共有、OIDC client 対応表が増える |
| 共有データ | global 状態と既存共有 grant | 読み手の project grant に加え、共有元・対象主体の policy が必要 |
| ロック | 1 状態で全サービス優先停止 | 全体ロックは依然必要。project revoke と別に持つ |
| 適する段階 | 本運用前・利用者限定・中央審査 | サービス運営主体や利用者群が独立した段階 |

A を初期導入し、サービス側の独自 ACL は維持する。将来 B に移るときも global locked を残し、A の active を「全サービス grant 自動付与」に変換しない。新規サービスの利用条件はその時に決める。

## 3. 推奨案の詳細

### 3.1 状態・権限者

`users.access_status = pending | active | locked`。role や passkeys.status、Redis logged_in とは独立した永続状態。欠落・未知値は拒否し、active へ補完しない。

| 遷移 | 実行者・条件 | 効果 |
|---|---|---|
| 作成 → pending | パスキー signup 検証成功 | 本人用 Cr session のみ。登録それ自体は申請通知を起こさない |
| pending → active | active な system admin、fresh passkey action proof、審査対象 ID・revision に束縛 | 申請承認を監査。旧 pending session を失効し、再認証後に利用可 |
| pending → locked | 同 admin が拒否 | request decision=rejected。停止理由は本人向けと内部向けを分離 |
| active → locked | 同 admin が停止 | 即時の論理失効、下流停止 outbox。停止理由必須 |
| locked → active | 同 admin が明示再許可 | 自動復元なし。旧 credential session・code は復活させずパスキー再認証 |

組織 admin は Cr 全体の許可権を持たず、推薦だけ可能。招待は初版では承認を代替しない。本人による自己承認不可。最初の admin は既存 `auth/admin-bootstrap.ts` の運用者 bootstrap を拡張し、role=admin と active を一体で設定・監査する。最初の登録者を admin にしない。最後の active admin を通常 UI で lock/demote できないようにし、緊急停止は運用者手順へ分ける。

### 3.2 最低限の権限

| 操作 | pending | active | locked |
|---|---|---|---|
| Cr ログイン、本人状態・申請履歴・logout | 可 | 可 | 通常 session 発行不可。一般化した停止案内のみ |
| 本人表示名・profile・privacy | 可。対象 ID は認証主体から固定 | 可 | 不可 |
| 本人パスキー一覧/追加/失効、端末管理、QR 回復・再発行 | 可。fresh proof と既存回復待機条件は保持 | 可 | 不可。回復で locked を解除しない |
| 通知先 OAuth 連携と到達確認 | 本人分のみ、送信 quota 内 | 可 | 不可 |
| 本人アカウント削除 | fresh proof 後に可 | 同左 | 運用者受付。通常認証を復活させない |
| 利用申請・取下げ | 可。1 件の open request と cooldown | 不要 | 再申請不可、異議申立ては運用者受付 |
| 他人検索/閲覧、組織・メンバー、project 一覧/データ/open | 不可 (R1–R3) | 関係・ロール・共有 grant の範囲 | 不可 |
| 汎用 relay、presence、組織イベント | 不可 (R4) | 宛先・受信者双方を検査 | 不可 |
| サービスログイン、同意、token、project_data 作成 | 不可 (R10–R14) | 各サービスの権限条件も必要 | 不可 |
| 管理者機能・export | 不可 | admin かつ目的別権限 | 不可 |

pending allowlist は module 名全体ではなく action と対象条件で定義する。`account_recovery` は現コードで運用者 grant を扱うため丸ごと許可しない。本人 QR の HTTP 経路と区別する。プロフィール更新に role/status/revision を混入できない strict 入力にする。汎用 relay を禁止しても、Cr 内部が発生させる本人宛てセキュリティ通知は受信可能にする。

### 3.3 判定の配置と競合

認証の検証 `assertUserSessionCurrent` と用途の認可 `requireAccess(subject, capability, resource)` (新設案) を分ける。前者は locked を拒否するが pending の本人設定を妨げない。後者は R1–R17 の各入口および共有サービス関数で強制する。新しい action は分類するまで拒否する。

DB を正本とし、初版では認可の正キャッシュを設けない。状態取得不能時は 503/認可失敗とし、最後に見た active にフォールバックしない。一覧は取得後に漏れた行を削るだけでなく、SQL の対象集合を制限する。背景ジョブ・push の送出直前も検査する。

承認・ロックは対象行 lock と expected revision による条件付き更新で直列化する。状態・authEpoch 増分・決定監査・outbox を同一 DB transaction で保存。サービス token 発行と project_data 行確保も同じユーザー行との競合制御下に置く。Redis code の後処理は transaction に含められないため、保存しても交換時の epoch/status 再検証で拒否できる構造にする。既に送出済みのデータは回収できず、ロック完了前から進行中の read を「なかったこと」にしない。

### 3.4 token と他サービス

- Cr 本人 session は `aud=Cr`、用途 `self` (pending) / `user` (active)、`authEpoch` を持つ提案。サービス側で Cr self token をログイン証明として受け入れない。クレームは補助情報で、現在状態の代替にしない。
- authCode は active のみ。送付先 project/client・許可 redirect・session epoch に束縛し、一度限りの消費時に再確認する。現在の汎用 token pair 保存形に target がない点は実装対象。pending 発行拒否は refreshSessions insert より前に行う。
- user×project PASETO は既存 aud/projectKey に `authEpoch` と状態契約バージョンを追加。要求の hub_url は登録済みの対象 audience と照合する。署名が正しいことだけで受理しない。
- OIDC は認可同意で `access_denied`、交換時の状態変化は `invalid_grant`、userinfo は無効 token として拒否。検証済み redirect_uri と state のみで戻し、内部審査理由を query に入れない。ID token に状態世代を載せても、RP の継続認可確認は別途必須。
- composite popup / redirect には成功 code の代わりに `approval_required` と相関 state を返す。SDK は origin/source/state を確認し、「Cernere の利用許可を申請してください」と固定 Cr URL を表示。サービス cookie / user row を作らない。承認後は再ログインし、以前の callback を自動実行しない。
- machine project/service credential の発行は人間登録承認から独立。ただしユーザー代理 API は署名検証済みの actor context が必要。payload.userId は対象 ID であって actor の証拠ではない。機械バッチは `principal=service`、明示 scope、対象 project/施設、監査目的を持つ別契約にする。

### 3.5 ロック時の失効と保証範囲

1. DB transaction で locked と authEpoch 更新。これ以降に始まる Cr の認可は拒否。状態変更 API は commit 後に成功を返す。
2. refreshSessions・Device Credential を失効。Redis session / composite ticket / authCode / OIDC record は削除または epoch 不一致で無効化。全 Cr インスタンスの WS を閉じ、キュー済みイベントも配送時に拒否する。物理削除遅延は論理失効を遅らせない。
3. 未完了 device pairing、登録 grant、回復 request、action proof を失効。既存パスキー公開鍵はロックだけでは削除しないが、認証成功から session を作れない。解除後も古い端末 session を再利用せず、新しいパスキー認証を要求する。
4. outbox から `user_access_revoked(userId, epoch, eventId)` を登録サービスへ配送。サービスは user の独自 cookie/session、WS、peer、代理ジョブ、データキャッシュを無効化し、冪等 ACK を返す。通知は認証された機械経路のみ。遅延・失敗・再試行を管理 UI に表示。
5. **下流の保護データ操作は毎要求オンライン認可を必須**とするのが初版の推奨。Cr 到達不能なら拒否。接続中 stream は各送出時、長いジョブは結果公開前に確認する。失効イベントは即時切断を促す補助で、配送成功だけを保証根拠にしない。

既存の 15 分 PASETO をローカル検証だけするサービスでは最長 token TTL 分の窓が残り、独自 session はさらに長く残る。これを即時ロックと表現しない。正キャッシュを将来採るなら失効上限を明記して別途合意する。機械バッチによる法的保全・アカウント削除は例外 scope と監査で限定する。既に外部へ送った公開情報・秘密情報はロックしても回収不能。

### 3.6 許可申請・UI・運用

登録直後は本人 onboarding と「利用許可待ち」。明示的な「申請する」で申請を 1 件作る。名前・利用目的・紹介の手掛かりを最小限入力させるが、通知先の所持や表示名一致を本人性の根拠にしない。申請一覧は active system admin のみ。詳細表示と許可/拒否/ロックは別操作にし、申請本文にリンクがあっても自動 fetch しない。

管理者通知は既存 outbox の配送方式を再利用し、専用イベント型と受信者解決を設ける。登録ごとの DM を送らず、例えば 15 分ごとの件数ダイジェストと管理画面固定 URL のみ。初期通知予算案は管理者宛て 1 時間 4 件、上限後も DB の申請は残す。管理者は画面で対象の不変 ID・申請履歴・推薦者を確認し、別経路の確認後に fresh proof で決定する。自己承認は禁止、高権限付与は二者確認とする。

監査には actor / target / before / after / reason code / requestId / revision / UTC 時刻 / eventId を記録。内部メモと本人向け通知を分離し、QR 秘密値・token・自由文全体を汎用操作ログにコピーしない。申請撤回・拒否・解除も追跡する。管理者通知をクリックするだけでは決定しない。

招待コードによる自動 active 化は初版では採らない。将来必要なら短命・digest 保存・単回消費・用途/発行者固定・利用数上限・失効可能とし、転送された bearer code だけで本人確認完了としない。locked を招待で解除できない。

放置 pending は最終申請/本人活動から 90 日で削除対象とする案。7 日前に確認済み通知先へ予告し、通知先未設定なら Cr 画面に期限を表示する。まず論理的な期限切れとログイン不可を確定し、既存削除処理で本人情報を削除する。監査保持期間と再登録悪用防止情報の保持は別 policy。削除競合時はユーザー行 lock 下で active に変わっていないか再確認し、active を消さない。

### 3.7 データ・migration

| 保存先 (提案) | 主な項目・制約 |
|---|---|
| users | access_status NOT NULL DEFAULT pending + CHECK、access_revision 単調増加、status_changed_at。既存 auth_epoch を token 全失効に再利用 |
| registration_requests | id, user_id, state(open/withdrawn/approved/rejected/expired), purpose, created_at, decided_at。user ごとの open は部分 unique |
| access_decisions | actor, target, expected_revision, before, after, reason_code, request_id, timestamp。状態変更と同一 transaction |
| outbox | access 変更イベントと宛先。eventId/service ごとに重複防止、attempt/next_at/ack_at。既存通知 outbox と責務を分けても配送原則は共用 |
| サービス契約 | 対象 audience/client、代理/機械 scope、失効確認方式、契約 version、最終適合確認。宣言だけでは適合としない |

DB リセット前提なので既存ユーザーを active に backfill しない。migration 番号は実装時の最新値から採番。bootstrap を除くすべての作成経路 (passkey / edge / enterprise / 運用作成) が pending を使う。旧 schema/旧 consumer を暗黙許容しない。

展開順は schema → 機能を公開しない状態で各サーバー/SDK/下流を更新 → 許可された検証 → 人間による DB リセットと bootstrap → 登録公開。状態列追加だけ先行して既存コードが素通しする期間を外部に公開しない。下流の未対応が残る場合はそのログイン経路を閉じたままにする。ロールバックも承認チェックの削除ではなく、サービスログイン停止を選ぶ。

## 4. 攻撃耐性

| 脅威 | 許可制の効き方 / 残るもの | 対策・観測 |
|---|---|---|
| 自動登録から他人データを収集 | pending の間は遮断。承認済み悪意・乗っ取られた active は残る | R1/R2/R4 の ACL 補修、閲覧最小化、検知と lock |
| 大量パスキー登録 | 本人性や一人一アカウントは保証しない。DB / Redis / 通知費用は減らない | signup begin/finish 別予算、IP/ネットワーク/全体 burst、challenge TTL、pending 総数上限、credential 数上限。容量不足時は明示拒否 |
| 通知・申請洪水 | admin の判断能力を狙える | 登録と申請を分離、1 open request、再送 cooldown、件数通知、通知 worker の上限。IP 単独制限で学校/NAT 全体を締め出さない |
| 本人設定の悪用 | pending にも通信・保存権がある | profile 文字数/サイズ制限、URL 自動 fetch 禁止、通知先確認・送信 quota、端末追加数制限、回復処理予算 |
| 審査者へのなりすまし・急かし | 最も大きい残余リスク | 既知経路での照合、申請文を命令として扱わない、リンク先で承認しない、対象 ID と proof を束縛、高権限二者確認 |
| 盗まれた code/token、承認との競合 | 発行だけ止めても残る | 交換/使用時 status と epoch、単回消費、tx 競合制御、下流 session 再検証 |
| service credential 流出 | 利用者承認とは独立に大量データへ届き得る | 目的別 scope、施設/対象制限、rotation、呼出元認証、機械と代理を分離。人間向け token の代用禁止 |
| 拒否後の再登録 | 新パスキーで別ユーザーになるため完全には防げない | 申請単位審査、容量制限、必要時の招待運用。追跡目的の過剰な個人情報収集はしない |
| 管理者侵害・誤承認 | 許可制そのものが突破される | fresh proof、監査、admin 最小化、権限付与と利用許可を分離、緊急停止手順 |
| 認可基盤停止 | fail closed によりサービスが止まる | 認可の可用性監視・復旧手順を用意。可用性のために pending/locked を通さない |

## 5. 実装の分割・再利用・受入条件

この節は後続実装の計画。今回は設計書のみを変更するため、augur 契約ファイル・述語・テストは作成せず、実行済みの証跡も主張しない。

| 単位 | 変更責務 | 再利用と採否 | 対の検証計画 |
|---|---|---|---|
| 1 状態・審査 | schema、状態遷移 service、bootstrap、決定監査 | authEpoch と admin bootstrap を再利用。role を承認状態に流用しない | 新規経路、禁止遷移、自己承認、最後の admin、競合決定 |
| 2 Cr 境界 | capability policy、commands、REST、WS inbound/outbound | assertUserSessionCurrent を拡張し認証の共通処理を維持。dispatch のみに集約しない | pending allowlist の正例/負例、target 偽装、非所属 active、idle socket 配送 |
| 3 外部ログイン | authCode・exchange・project token・OIDC・SDK エラー表示 | GETDEL、epoch、OIDC client/PKCE 検査を維持。汎用 code を target 無しで再利用しない | 発行→lock→交換、同時消費、audience 不一致、project 行ゼロ |
| 4 service データ | 代理 context、機械 scopes、roster/export/peer | profile grant、data_sharing の列解決を AND 条件で再利用 | missing actor、機械 scope 違反、非 active 対象、cross-project 列制限 |
| 5 失効連携 | transaction/outbox、サービス ACK とオンライン認可 | 通知 outbox の永続化・再試行原則を採用。通知到達を失効判定に流用しない | 配送失敗、再配送、接続中 peer、Cr 不通、古い service session |
| 6 UI・運用 | 申請/審査/lock UI、通知集約、期限処理 | 本人 onboarding と fresh action proof を再利用 | 二重 click、古い revision、通知洪水、期限処理と承認の競合 |

後続実装では最初に `augur plan` で以下の契約とテストを対応させ、実装より先に augur.contracts.json / 述語を作成する。サービス起動を伴う検証は別途許可された環境で行う。

C-1 createPendingAccount(path): すべての人間アカウント作成経路は pending になり、bootstrap 以外が admin/active を自己付与できない。

C-2 authorizeSelfOnly(action, actor, target): pending は明示した本人用操作のみ成功し、他人検索・組織・project・汎用 relay・未知 action は副作用なしで拒否される。

C-3 enforceResourceBoundary(actor, resource): active でも非所属 org、無関係 user/session、未許可列・施設のデータへ到達できない。

C-4 denyExternalCredential(status, path): pending/locked は R10–R14 の code/token を取得・交換できず、refreshSessions と project_data の外部利用行も増えない。

C-5 serializeApproval(decision): 審査と lock の競合は revision で検出し、状態・epoch・監査・outbox が一体で commit/rollback される。

C-6 invalidateEverySession(user): lock 後の新しい Cr 認可判定、refresh、device 復帰、OIDC userinfo、WS 配送は旧資格で成功せず、回復や解除でも旧資格は復活しない。

C-7 enforceServicePrincipal(request): payload userId だけでは代理主体を作れず、機械データ取得は scope/対象制約を満たし、非 active の情報を通常結果へ出さない。

C-8 revokeDownstreamSession(service): 適合サービスは既存 cookie/WS/peer を含む保護操作を現在状態で判定し、失効イベント未配送と Cr 不通でもアクセスを継続しない。

C-9 boundRegistrationLoad(load): signup/申請/通知/本人設定の予算超過で保存・送信が上限を越えず、管理者に通知洪水を起こさない。

C-10 retainAccountIsolation(cleanup): pending の期限削除と承認が競合しても active を削除せず、監査と秘密値の保持境界を守る。

## 6. 未決事項 (推奨つき)

| 未決事項 | 推奨 |
|---|---|
| 許可の本人確認基準 | 既知の連絡経路で確認した紹介/用途を基準にする。パスキー所持だけでは本人確認済みにしない |
| 下流のオンライン認可 API と利用可能性 | 既存 verify を拡張するか専用 API を設け、subject・audience・epoch を機械認証の下で検証。全接続先を一覧化して適合を確認するまで公開しない |
| locked の本人削除・異議申立て | 初版は運用者窓口。将来必要なら本人証明だけの限定手続きを別設計し、通常 session を再開しない |
| 企業 SSO の自動承認 | 初版は例外なし。導入時に特定 connection の信頼と責任者を明記し、global locked を必ず優先する |
| pending 保持期間と監査保持期間 | pending は 90 日・7 日前予告を初期案。監査は運用目的に基づき別途決定。期限値は設定として持つ |
| 管理者審査の規模 | 初版は中央審査。負荷が明らかになった時点で B の project grant を検討する |
| 招待・大量登録の制限値 | 初版は招待による自動承認なし。通知上限以外の具体値は通常負荷と共有 NAT の実測後に設定し、許可された負荷検証で確定する |

本設計の検証範囲は指定 worktree のコード読解と設計整合確認。攻撃の実行、テスト、サービス起動、下流コードの適合検証は未実施。
