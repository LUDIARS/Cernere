# Cernere データ保持・削除ポリシー

Cernere が保持するデータの保持期間と削除契機を定める。新しいテーブルを追加する
ときは、本ドキュメントに保持区分を追記してから migration を出す。

## 保持区分

| 区分 | 定義 | 削除契機 |
| --- | --- | --- |
| 本人データ | ユーザ本人に帰属する内容 (プロファイル、アンケート回答等) | 本人の削除要求 / アカウント削除で即時消去 |
| 監査メタデータ | 誰が何をしたかの記録。内容そのものは含まない | 保持期間経過で消去 + アカウント削除で即時消去 |
| 資格情報 | token / secret / credential | 失効・ローテーションで即時消去 |

監査メタデータは「本人データではないが本人に紐づく」ため、無期限保持はしない。

## テーブル別の保持期間

| テーブル | 区分 | 保持期間 | 削除契機 |
| --- | --- | --- | --- |
| `volputas_survey_responses` / `volputas_survey_answers` | 本人データ | 無期限 (本人が保持を選択している間) | `users` 削除で FK CASCADE。再回答は同一 transaction で置換 |
| `volputas_survey_access_logs` | 監査メタデータ | **365 日** | 保持期間経過で purge / アカウント削除で明示 purge |
| `operation_logs` | 監査メタデータ | 未定 (既存踏襲) | アカウント削除で明示 purge (`deleteUserAccount`) |

## volputas_survey_access_logs

Volputas アンケート回答は project WebSocket command 経路 (`/ws/project`) で参照・
上書きされる。この経路は user WS の dispatcher を通らないため `operation_logs` に
到達せず、Cernere が預かる中でも特に機微な store が無記録になっていた。本テーブル
はその経路専用の監査シンクである。

### 保存する / しない

保存するのは `project_key` / `user_id` / `survey_id` / `action` / `status` /
`error_code` / `created_at` のみ。

- **回答本文・payload 本体・token・credential は保存しない。**
- `error_code` は自由文ではなく閉じた区分値で、DB 側 CHECK 制約でも強制する。
  例外メッセージに回答値が混ざっていても監査ログには出ない。
- `user_id` / `survey_id` は UUID 形の値だけを採り、それ以外は `NULL` に落とす。
  未検証 payload がそのまま識別子カラムへ流れ込む経路を作らない。

### 保持期間 — 365 日

`VOLPUTAS_SURVEY_AUDIT_RETENTION_DAYS`
(`server/src/project/volputas-survey-audit-repository.ts`) を正本とする。
不正アクセス調査は年次の棚卸しサイクルで足り、それを超えて `user_id` を保持する
理由が無いため 365 日とした。変更時は本ドキュメントと定数の両方を更新する。

`purgeExpired(now)` が `created_at < now - 365日` の行を削除する。
`idx_volputas_survey_access_logs_created` が sweep を index driven に保つ。

Cernere には定期ジョブ基盤が無いため、purge の起動は運用側 (Excubitor の定期実行
など) に委ねる。呼ばれない限り行は残るので、運用配線までが本ポリシーの完了条件。

### アカウント削除時

`deleteUserAccount` が `users` 削除の前に該当 `user_id` の行を明示 purge する。
本テーブルは `users(id)` への FK を **意図的に張っていない** — 認可拒否や不正
payload は未知の `user_id` を伴い得るので、FK があると監査行の insert 自体が
弾かれ、記録すべき拒否がまさに消える。FK が無い代償として CASCADE が効かない
ため、削除は明示的に行う。

### fail-safe

監査ログの書き込み失敗は本処理 (回答の参照・保存) を止めない。ただし無音にはせず、
固定区分値のみを stderr へ出す (`[volputas_survey_access_logs] insert failed`)。
監査シンクの障害で本人がアンケートを保存できなくなる方が損害が大きい、という
トレードオフを明示的に採っている。
