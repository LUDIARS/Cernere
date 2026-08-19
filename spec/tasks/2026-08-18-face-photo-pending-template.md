# 顔写真の封緘保存と写真由来 pending テンプレートの審査導線

## 目的

生徒のプロフィール顔写真を Cernere に 1 人 1 枚だけ封緘保存し、その写真から抽出した顔テンプレートを「職員が承認するまで照合に使わない」状態 (`state='pending'`) で保持できるようにする。これにより、GLab 側の写真アップロードと Ostiarius の対面登録を、同一の同意・削除・監査の枠組みに載せたまま接続できる。写真は個人データそのものなので、鍵の分離・一括取得の禁止・削除の同期・監査の 4 点を満たすことを実装の前提とする。

## 完了条件

- `face_photos` テーブル (user_id 一意、ciphertext / iv / tag / key_id / mime / width / height / byte_size / consent_id) と `face_templates.state` を migration 045 で追加し、既存行を `'active'` で backfill する。
- 写真はテンプレートとは別鍵 (`FACE_PHOTO_STORAGE_KEY` / `FACE_PHOTO_KEY_ID`) で AES-256-GCM 封緘し、鍵または `FACE_SIDECAR_URL` が未設定なら写真 API 全体が 503 になる。
- `POST /api/identity/face-photo` が multipart 1 枚を受け、写真保存を明記した同意版 `face-photo-v1` の有効な同意が無ければ 409 `consent_required`、顔 0 件 / quality 不合格なら 422 で写真も保存しない。成功時は長辺 1024 / JPEG を封緘保存し、`state='pending'` のテンプレートを upsert する。
- `GET /api/identity/face-photo/me` と `GET /api/identity/face-photo/:userId` (active な tool client の scope `face-photo:read` または admin user) が 1 件ずつだけ画像を返し、`Cache-Control: private, no-store` を付ける。一括取得の口を作らない。
- `DELETE /api/identity/face-photo` / `DELETE /api/identity/face-photo/me` は本人 token、`DELETE /api/identity/face-photo/:userId` は active な tool client の scope `face-photo:manage` または admin user に限定し、写真と紐付くテンプレートを同一トランザクションで削除して tombstone を残す。
- `POST /api/identity/face-template/:userId/promote` (`reenroll` / `promote-photo`) と `POST /api/identity/face-template/:userId/reject` (`reason` 必須、未指定は 400) は `face-photo:manage` scope または admin user を要求する。`enrolledBy` は認証された tool owner / admin user と一致し、対象施設の reviewer role を持たなければならない。
- `GET /api/identity/face-template/export` が `state='active'` のみを返し、pending が配布されないことをテストで担保する。
- 既存の削除トリガ (本人撤回 / service 失効 / 所属離脱 / 施設削除 / アカウント削除 / 365 日再同意なし) すべてで写真も同時に削除される。
- 写真の保存 / 取得 / 削除 / promote / reject が `operation_logs` に残り、写真バイト・base64・埋め込みをログ・エラー文言に出さない。
- Cernere frontend のプロフィール顔認証欄に `審査待ち (pending)` 表示を追加する (アップロード UI は作らない)。
- 写真保存を明記した同意版 `face-photo-v1` を定義し、`GET /api/identity/face-consent/policy` が版付き (全版の版名・文面・requiredFor) で返す。
- 同意版は経路ごとに分ける。写真経路は `face-photo-v1` のみ、テンプレート経路は `face-template-v1` 以上で有効とし、版上げで出席照合が止まらないようにする。判定は face-consent-guard.ts の 1 箇所に閉じる。
- 同意版の切替で `face-template-v1` を選んだ場合は旧同意に紐付く写真を即時削除し、写真を「保存しない」版へ付け替えない。
- 写真 upload と同意撤回・所属解除が競合しても、mutation lock 後の transaction 内再検証により失効済み同意へ写真・pending template を保存しない。
- 写真を保持できる同意版へ切り替えた際に、既存の face_templates を新しい consent_id へ付け替え、face_photos は consent_id を含む AES-GCM AAD も新 ID で再封緘してから同一トランザクションで付け替える。写真を保持できない版への切替では写真を削除する。
- Cernere frontend の「写真は保存しません」の文言を新しい事実に合わせる。
- 上記を server/tests/ の回帰テストで担保し (旧版同意での写真アップロードが 409、同じ生徒のテンプレート経路は通ることを含む)、spec/feature/face-template-store.md を更新する。
