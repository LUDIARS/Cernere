# 顔テンプレート保存・配布

対面登録で受け取った顔写真や動画は保持せず、512 次元の特徴テンプレートだけを `face_templates` に AES-256-GCM で暗号化して保存する。本人が別途同意して登録するプロフィール顔写真だけは、後述の制約で 1 人 1 枚を封緘保存する。保存暗号文には user・facility・model・version を AAD として結び付け、DB 内で暗号文やメタデータを差し替えても認証に失敗させる。

## API

- `PUT /api/identity/face-template`: service Bearer、現行 policy の有効な `consentId`、対象者と登録担当者の施設所属を要求する。平文テンプレートは保存しない。
- `GET /api/identity/face-template/export?facilityId=`: service/admin Bearer。施設配布鍵で再暗号化した全量と、30 日間の tombstone を返す。配布鍵のない施設は拒否する。
  応答は `{ modelId, templates, revoked }` で、`templates` の各要素は
  `{ userId, template, keyId, modelId, quality, version, state, enrolledAt, revoked }` を必ず含む。
  `state` を省略してはならない (Ostiarius は `state` を確認できないテンプレートを照合キャッシュへ入れない)。
- `POST /api/identity/face-consent` と `GET /api/identity/face-consent/policy`: 本人同意と version 付き同意文。現行 policy version と本人の施設所属を検証する。
  同意は常に**本人の access token** で記録する。 service token で他人の同意を代筆させてはならない。 kiosk (Ostiarius) は生徒が自分で発行した authCode を `POST /api/auth/code/exchange` (service Bearer) で `{ userId, accessToken }` に交換し、その accessToken で同意を打つ。 交換口は refreshToken を返さないため、共有端末に長期資格情報が残らない ([../interface/auth-flows.md](../interface/auth-flows.md) 「共通: kiosk 向け限定交換」)。
- `DELETE /api/identity/face-template`: 本人撤回。`DELETE /api/identity/face-template/:userId?facilityId=`: service による施設指定・理由必須の無効化。
- `GET /api/identity/roster?facilityId=`: service/admin に弱識別 hint と所属 role だけを返す。

## 保持と鍵

同意撤回、所属・施設削除、アカウント削除、または 365 日の再同意なしでテンプレートを物理削除し tombstone を残す。期限切れは起動時と参照・配布時に回収し、tombstone は export で 30 日間配布した後に物理削除する。`FACE_TEMPLATE_STORAGE_KEY` は base64 32 byte、`FACE_TEMPLATE_DISTRIBUTION_KEYS` は `facilityId` から base64 32 byte への JSON とし、いずれも env-cli/Infisical から注入する。値をリポジトリや平文設定ファイルに置かない。

## プロフィール顔写真 (1 人 1 枚) と pending テンプレート

顔写真は「本人確認の目視照合」と「テンプレートの種」のためだけに 1 人 1 枚保持する。`face_photos` に AES-256-GCM で封緘し、鍵はテンプレート鍵と分ける (`FACE_PHOTO_STORAGE_KEY` / `FACE_PHOTO_KEY_ID`)。鍵または `FACE_SIDECAR_URL` が未設定なら写真 API は 503 で fail closed とし、平文が DB に落ちる経路を作らない。

保存は表示用に長辺 1024 の JPEG へ正規化した 1 枚だけで、抽出のために縮小したフレーム (sidecar の 200,000 bytes 制限に収める) と平文の埋め込みは保持しない。顔 0 件または `quality.pass=false` は 422 とし、**写真も保存しない**。

`face_templates.state` は `'pending' | 'active' | 'revoked'`。写真から自動抽出したテンプレートは必ず `'pending'` で入り、`GET /api/identity/face-template/export` は `'active'` だけを配布する。配布する各要素にも `state: "active"` を載せ、受け手が状態を検証できるようにする。pending は照合経路に一切乗らない。職員は `POST /api/identity/face-template/:userId/promote` (`mode: 'reenroll'` 既定 / `'promote-photo'`) で承認し、`POST /api/identity/face-template/:userId/reject` (`reason` 必須) で却下する。却下は pending テンプレートと写真を同時に削除する。

写真 API は 1 件ずつしか返さない (`GET /api/identity/face-photo/me`、`GET /api/identity/face-photo/:userId` は active な tool client の scope `face-photo:read` または admin user が必要)。scope を持たない project token には暗黙で写真権限を与えない。応答は `Cache-Control: private, no-store`。一括取得の口・写真のキャッシュ保存・Ostiarius への写真配布は作らない。
写真 read 自体も `face-photo-v1` の同意が未撤回・365 日以内で、本人が対象施設に在籍中かを確認する。期限回収ジョブの実行前でも、失効済み写真を応答してはならない。

service による写真削除・promote・reject は、active な tool client の scope `face-photo:manage` または admin user に限定する。request body の `enrolledBy` は認証主体 (tool owner / admin user) と一致しなければ拒否し、project token や別職員 ID の申告だけでは管理操作を許可しない。promote / reject では、その認証主体が対象施設の reviewer role を現在も持つことを保存 transaction 内で確認する。

写真は user 単位で 1 枚だが、保存根拠はアップロード時の施設同意 1 件 (`consent_id`) に固定する。施設単位の撤回・所属離脱・期限切れ・reject では、その同意に直接紐付く写真だけをテンプレートと同じ transaction で削除し、別施設の有効な同意へ紐付く写真は削除しない。本人が写真そのものを削除する場合とアカウント削除では、写真と全施設のテンプレートを同時に削除する。写真の保存 / 取得 / 削除 / promote / reject は `operation_logs` に「誰が・誰に・どの施設で・どんな理由で」だけを残し、写真バイト・base64・埋め込みは記録しない。

## 同意版 (policyVersion) と経路ごとの要求

同意版は 2 つあり、新しい版が古い版を包含する。

| 版 | 文面の要点 | 有効な経路 |
|---|---|---|
| `face-template-v1` | 写真は保存せず、暗号化した特徴テンプレートのみを保持する | テンプレート経路のみ |
| `face-photo-v1` | 顔写真 1 枚を暗号化して保存する。表示先は職員の名簿・出席確認画面と本人のプロフィールのみ (kiosk には出さない)。削除・撤回で写真とテンプレートが同時に消える | テンプレート経路 + 写真経路 |

- `POST /api/identity/face-photo` は `face-photo-v1` の有効な同意を必須とする。`face-template-v1` の同意しか無い生徒の写真は保存せず 409 `consent_required` を返す。
- 画像の正規化・sidecar 抽出中に所属解除または同意撤回が起き得るため、user 単位の mutation lock 取得後、DB 保存直前に所属と同意を transaction 内で再検証する。事前確認の結果だけで保存してはならない。
- 新規・再同意は API が示す既知の版だけを受理する。`face-photo-v1` から写真を保存しない `face-template-v1` へ切り替えた場合は、旧同意に紐付く写真を同一 transaction で即時削除し、写真を template-only 同意へ付け替えてはならない。
- `PUT /api/identity/face-template`・`GET /api/identity/face-template/export`・`GET /api/identity/face-template/status` は `face-template-v1` 以上で有効。版上げによって既存同意が一斉に旧版化し、出席照合が止まることはない。
- 判定は `face-consent-guard.ts` の 1 箇所に閉じ、経路は要求する版の一覧を渡すだけにする。
- `GET /api/identity/face-consent/policy` は最新版 (`version` / `text`) に加えて `policies[]` で全版の版名・文面・`requiredFor` を返す。GLab と Ostiarius の同意画面はこの API から版と文面を取得して表示し、取得した版を `POST /api/identity/face-consent` へそのまま返す。これが両者との契約。
- 同意版を切り替えると旧同意は撤回済みになるため、既存の `face_templates` は新しい `consent_id` へ付け替える。写真を保持できる版へ移行する場合、`face_photos` は `consent_id` を AES-GCM の AAD に含むため、旧同意 ID で開封し、新同意 ID で再封緘してから同一 transaction 内で付け替える。DB の外部キーだけを更新してはならない。写真を保持できない版への切替では再封緘せず削除する。
