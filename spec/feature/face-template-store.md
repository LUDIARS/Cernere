# 顔テンプレート保存・配布

顔写真や動画を Cernere は保持しない。512 次元の特徴テンプレートだけを `face_templates` に AES-256-GCM で暗号化して保存する。保存暗号文には user・facility・model・version を AAD として結び付け、DB 内で暗号文やメタデータを差し替えても認証に失敗させる。

## API

- `PUT /api/identity/face-template`: service Bearer、現行 policy の有効な `consentId`、対象者と登録担当者の施設所属を要求する。平文テンプレートは保存しない。
- `GET /api/identity/face-template/export?facilityId=`: service/admin Bearer。施設配布鍵で再暗号化した全量と、30 日間の tombstone を返す。配布鍵のない施設は拒否する。
- `POST /api/identity/face-consent` と `GET /api/identity/face-consent/policy`: 本人同意と version 付き同意文。現行 policy version と本人の施設所属を検証する。
- `DELETE /api/identity/face-template`: 本人撤回。`DELETE /api/identity/face-template/:userId?facilityId=`: service による施設指定・理由必須の無効化。
- `GET /api/identity/roster?facilityId=`: service/admin に弱識別 hint と所属 role だけを返す。

## 保持と鍵

同意撤回、所属・施設削除、アカウント削除、または 365 日の再同意なしでテンプレートを物理削除し tombstone を残す。期限切れは起動時と参照・配布時に回収し、tombstone は export で 30 日間配布した後に物理削除する。`FACE_TEMPLATE_STORAGE_KEY` は base64 32 byte、`FACE_TEMPLATE_DISTRIBUTION_KEYS` は `facilityId` から base64 32 byte への JSON とし、いずれも env-cli/Infisical から注入する。値をリポジトリや平文設定ファイルに置かない。
