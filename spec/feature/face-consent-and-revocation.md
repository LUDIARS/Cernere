# 顔認証の同意記録と失効指示

Cernere は顔テンプレートと顔写真を**保存しない**。正本は施設の受付端末 (kiosk) 上の
Ostiarius にあり、生体情報は施設外へ出ない (Ostiarius `spec/plan/face-data-local-only.md`、
`spec/interface/cernere-face-template.md` §A)。Cernere が持つのは次の 2 つだけである。

- **同意記録** (`face_consents`): 誰が・どの施設で・どの版の同意文に・いつ同意し、いつ撤回したか。
- **失効指示** (`face_revocations`): 「この user の、この施設の顔データを消せ」という指示。30 日保持。

生体情報 (テンプレート・写真バイト・base64・埋め込み) は DB・API 応答・ログのいずれにも現れない。

## 撤去したもの (2026-09-12)

`face_templates` / `face_photos` / `face_template_tombstones` (migration 041 / 045) を
読み書きするコードは全て撤去した。テーブル自体を物理削除する migration は **まだ出していない**
(2026-09-12 判断で保留)。`CLAUDE.md` RULE §2 が `DROP TABLE` を禁じており、生体情報の物理削除は
その禁止事項に対する意図的な例外になるため、許可を取ってから単独の migration として出す。
それまでこれらのテーブルは参照されない死蔵テーブルとして残る。export はしない —
既登録者は施設の kiosk で再 enroll する。

同時に撤去した API と env:

- `PUT /api/identity/face-template`、`GET /api/identity/face-template/export`、
  `GET /api/identity/face-template/status`、`DELETE /api/identity/face-template`、
  `DELETE /api/identity/face-template/:userId`、
  `POST /api/identity/face-template/:userId/promote`、`.../reject`
- `POST|GET|DELETE /api/identity/face-photo*` (GLab からの写真アップロード経路を含む)
- env: `FACE_TEMPLATE_STORAGE_KEY` / `FACE_TEMPLATE_DISTRIBUTION_KEYS` /
  `FACE_PHOTO_STORAGE_KEY` / `FACE_PHOTO_KEY_ID` / `FACE_SIDECAR_URL` / `FACE_SIDECAR_TIMEOUT_MS`

`server/tests/http/face-legacy-surface-removed.test.ts` が、これらの URL 登録・
`face_templates` / `face_photos` への参照・`FACE_*` env の読み取りが戻ってこないことを見る。

## API

すべて `/api/identity/` 配下。service 経路は tool client の scope (または admin user) を要求し、
scope を発行できない project token には暗黙の権限を与えない (`service-scope-auth.ts`)。

### 本人 (生徒の access token)

- `GET /api/identity/face-consent/policy`: 版と文面。`policies[]` で全版の版名・文面・
  `requiredFor`・`deprecated` を返す。kiosk と GLab の同意画面はここから版を取り、
  その版を `POST /api/identity/face-consent` へそのまま返す。これが両者との契約。
- `POST /api/identity/face-consent` (`{ policyVersion, facilityId }`): 同意を記録する。
  **現行版以外は 409 `current_policy_consent_required`**。同意は常に本人の access token で
  記録し、service token で代筆させない (kiosk は `POST /api/auth/code/exchange` で本人の
  accessToken を得てから打つ)。
- `GET /api/identity/face-consent/status`: 自分の有効な同意一覧
  (`facilityId` / `consentId` / `policyVersion` / `at` / `reconsentRequired`)。
  テンプレートの有無は返さない (Cernere は知らない)。
- `DELETE /api/identity/face-consent?facilityId=`: 本人撤回。同意に `revokedAt` を打ち、
  失効指示 `withdrawn` を積む。`facilityId` 省略で全施設。

### service (Ostiarius)

- `GET /api/identity/face-revocations?facilityId=&since=` — scope `face-revocation:read`。
  res: `{ revocations: [ { userId, facilityId, reason, at } ] }`。
  `facilityId` は必須 (施設を跨ぐ全量取得の口は作らない)。`since` は保持期間 (30 日) の境界まで
  切り上げる: それより前は既に回収済みで、「指示が無い = 削除不要」と誤解させないため。
  バックアップ復元時は `since` を復元時点の 30 日前にして全量適用してから照合を再開する。
- `GET /api/identity/face-consents?facilityId=` — scope `face-consent:read`。
  res: `{ consents: [ { userId, consentId, policyVersion, at, revokedAt } ] }`。
  Ostiarius は写しとして保持し、「同意が有効か / 365 日以内か / 現行版か」を Cernere 不通時にも
  自前判定する。撤回済みの行も `revokedAt` 付きで返す。
- `POST /api/identity/face-consent/revoke` — scope `face-consent:revoke`。
  body `{ userId, facilityId, revokedBy, reason? }`。kiosk 上で本人が (職員立会いで) 登録を
  削除したときに Cernere 側の同意へ `revokedAt` を打ち、失効指示を積む。`reason` 既定は
  `withdrawn`。`revokedBy` はその施設の reviewer role (owner / admin / maintainer) を
  現に持つ user でなければ 403 — 申告だけで他施設の登録を消させない。
  Ostiarius は先にローカルを物理削除し、この呼び出しは outbox で再送する。
- `GET /api/identity/roster?facilityId=` — 変更なし (admin / project token)。弱識別 hint と
  所属 role だけを返し、氏名フルは返さない。

`POST /api/auth/code/exchange` と passkey export の `roles` / `facilityIds` 拡張も変更なし。

## 失効指示の理由と発生源

| reason | 積む場所 |
|---|---|
| `withdrawn` | 本人撤回 (`DELETE /api/identity/face-consent`)、kiosk 由来の撤回 (`POST .../face-consent/revoke`) |
| `left_facility` | 所属離脱 (`organization.removeMember`)、施設削除 (`organization.delete`) |
| `graduated` | `POST .../face-consent/revoke` に `reason: "graduated"` |
| `account_deleted` | アカウント削除 (`project/service.ts` の deleteUser) |
| `consent_expired` | 365 日再同意なしの回収 (`purgeExpiredFaceConsents`、起動時と配布時) |
| `staff_invalidated` | 職員による無効化 (`POST .../face-consent/revoke` に `reason: "staff_invalidated"`) |

契約外の理由は 400 で弾く (Ostiarius の削除判断に未知の語彙を流さない)。

同意行が 1 件も無くても、施設が分かっているなら指示は積む — kiosk 側にだけ登録が残る
取りこぼしを作らないため。既に撤回済みの同意についても積む (指示は冪等)。

失効指示は `at` が 30 日より前になった時点で回収する (起動時と配布時)。
回収後は Ostiarius から見て「指示が無い」状態になるので、`since` の切り上げと合わせて
「30 日以内に必ず 1 回は pull する」ことを Ostiarius 側の前提とする。

## 同意版 (policyVersion)

| 版 | 状態 | 文面の要点 |
|---|---|---|
| `face-template-v1` | 旧 (提示しない) | 写真は保存せず、暗号化した特徴テンプレートのみを Cernere が保持する |
| `face-photo-v1` | 旧 (提示しない) | プロフィール顔写真 1 枚を Cernere が封緘保存する |
| `face-local-v1` | **現行** | 保存先は施設の受付端末 (kiosk) のみ。施設外 (クラウド) へ出さない。表示は施設内の職員画面 (名簿・出席確認) と本人に限り、kiosk 待機画面には出さない。在籍中かつ同意から 365 日まで保持し、撤回・卒業・所属終了・アカウント削除で施設の端末から削除する |

- 旧版は**既存同意行を読むためだけに**残し、新規・再同意では受理しない
  (`isAcceptableNewConsentVersion`)。旧版の同意しか無い生徒には再同意を求める
  (`GET /api/identity/face-consent/status` の `reconsentRequired`)。
- 旧版から現行版への切替は旧同意を撤回済みにして新しい行を入れるだけで、**失効指示は積まない**
  (本人が新しい版に同意した直後に、その場の再 enroll を消させない)。
- 同じ版の再同意は `at` を更新する (365 日の起点を延ばす)。
- 判定は `face-consent-guard.ts` の 1 箇所に閉じる。

## 監査

同意の記録・撤回・配布は `operation_logs` に「誰が・誰に・どの施設で・どんな理由で」だけを残す
(`logging/face-audit.ts`)。`revokedBy` は認証主体とは別の `delegatedUserId` として記録する。
生体情報は記録対象に存在しない。
