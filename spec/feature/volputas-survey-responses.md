# Volputas アンケート回答保管

## 目的

Corpus / EducationLab から回答された Volputas アンケートについて、設問定義と本人回答の
権威ソースを分離する。

- 設問、カテゴリ、公開可否の権威ソースは **Volputas**。
- Cernere user に紐づく本人回答の権威ソースは **Cernere**。
- Cernere は Volputas の survey ID / question ID を外部キー化せず、回答値を
  TEXT または INTEGER のどちらか一方へ正規化して保管する。

## データフロー

1. EducationLab は Cernere user access token を Volputas 向け短命project-tokenへ交換する。
2. Volputas は token の署名、audience、project key、subjectを検証する。
3. Volputas backend は起動時に Excubitor から受け取ったproject credentialで
   Cernere `/ws/project`へ接続する。
4. `volputas_survey.*` commandのpayloadへ、検証済みsubjectを`userId`として渡す。
5. Cernere は接続projectが`volputas`であることとpayload schemaを検証し、
   response / answerを単一transactionで置換する。

本人性のtoken検証は Volputas ingress の責任である。Cernere project WS は認証済み
Volputas serviceを信頼境界とし、受領した`userId`がCernere userとして存在することを
外部キーで保証する。他projectからの同commandは、DBアクセス前に拒否する。

## 保護

- 回答値は本人に紐づく保護対象ユーザーデータ。
- query parameter、operation log、例外本文へ回答値を含めない。
- 読み書きは`projectKey=volputas`のproject WS commandだけに限定する。
- response headerとanswerは単一SQLで読み、再回答と混ざったsnapshotを返さない。
- 再回答は既存answerを削除して全件挿入するが、同一transaction内で行い、
  途中失敗時は以前の回答を保持する。
- Cernere user削除時はresponse / answerをcascade削除する。

## アクセス監査

project WS command 経路は user WS の dispatcher を通らないため`operation_logs`へ
到達しない。回答の参照・上書きを無記録にしないよう、この経路専用の監査シンク
`volputas_survey_access_logs`へ 1 コマンド 1 行を記録する。

- 記録するのは`project_key` /`user_id` /`survey_id` /`action` /`status` /
  固定`error_code`のみ。回答本文・payload・token は記録しない。
- 成功 (`ok`)、失敗 (`error`)、認可拒否 (`denied`) の全てを記録する。認可拒否は
  実処理・DBアクセスより前に判定し、拒否そのものを残す。
- `error_code`は`project_not_authorized` /`invalid_payload` /`storage_failure` /
  `internal_error`の閉じた集合。DB側 CHECK 制約でも自由文を拒否する。
- 監査ログの書き込み失敗は fail-safe とし、本処理を止めない (stderr へ区分値のみ)。

保持期間と削除方針は`spec/data/retention.md`を正本とする。

## Migration

`036_volputas_survey_responses.sql`は、並行作業中のmigration 030–035との番号衝突を
避けるため036を採番した。先行するresponse tableが既に存在する環境でも、
question ID・TEXT長・exactly-one・survey/user unique制約を明示的に追加し、
同じ保護境界へ収束させる。

同migrationは`managed_projects.key=volputas`を実値credentialなしでseedし、
ExcubitorからVolputas向け起動credentialを発行できるissuer許可も追加する。
旧`volputas_game_review`固定projectや固定回答列は作成しない。
