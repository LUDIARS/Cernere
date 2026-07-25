# migrations/

`{番号}_{説明}.sql` の連番。ランナーは `server/src/db/migrate.ts`。
適用済み判定は `_migrations` テーブルの **ファイル名 (拡張子なし)** で行う。
チェックサムは取らないため、未マージのローカル WIP を採番し直しても既存 DB は壊れない
(内容が冪等な UPSERT / `IF NOT EXISTS` である限り)。

規約は `CLAUDE.md`「2. DB マイグレーション」を参照。番号の重複・再利用は禁止。

## 030-035 (ローカル WIP) の整理 — 2026-07-25

`036_volputas_survey_responses.sql` (PR #154) がマージされた時点で、
ローカルに未マージのまま採番済みだった 030-035 が宙に浮いていた。
036 のヘッダにある「intentionally skips locally reserved WIP numbers 030-035」は
この状態を指す。本 PR で以下のとおり整理し、030-035 という番号は**欠番のまま**とした
(番号の再利用禁止のため、生き残りは 038 以降へ採番し直した)。

### 036 に取り込み済み / 設計上退役 → 不採用

| WIP | 内容 | 判定 |
|-----|------|------|
| `032_volputas_game_review_schema.sql` | `volputas_game_review` managed project + 設問 JSON を `schema_definition.questionnaire` に持ち、回答を `project_data_volputas_game_review` の**固定カラム** (game_title / overall_rating / …) へ保存する旧設計 | **不採用**。設問の正本は Volputas 側へ移り (033 のコメントで既に退役宣言済み)、回答は 036 の `volputas_survey_responses` / `volputas_survey_answers` へ正規化された。`volputas` managed project の seed 部分は 036 が同等の UPSERT を持つ |
| `033_volputas_survey_responses.sql` | 036 とほぼ同一のテーブル定義 (制約に名前が無く、question_id 形式・本文長・重複検査が無い版) | **不採用**。036 の直接の前身。036 は「033 が先に流れた DB」を想定した収束 `DO $$` ブロックを持つため、033 を消しても既存環境は 036 側で回収される |
| `034_excubitor_volputas_launch_credentials.sql` | `project_credential_issuers` へ (volputas, excubitor) を UPSERT | **不採用**。036 が全く同じ UPSERT を含む (完全な重複) |

`032` が作る `project_data_volputas_game_review` テーブルはコードから参照されておらず
(`project_data_*` は `server/src/project/schema-migrator.ts` が managed project 定義から
動的生成する)、固定カラム型の回答ストアは 036 の正規化ストアと二重管理になるため採用しない。
既に手で 032 を流した開発 DB がある場合テーブルは残るが、誰も読まない
(規約により `DROP TABLE` はしない)。

### Volputas 回答ストアと無関係 / 有効 → 採番し直して採用

| WIP | → | 内容 |
|-----|---|------|
| `030_volputas_survey_authoring.sql` | `038_volputas_survey_authoring.sql` | `volputas_users` managed project (`can_create_surveys`)。アンケート**作成権限**であって回答ストアではないので 036 と競合しない |
| `031_tirocinium_career_schemas.sql` | `039_tirocinium_career_schemas.sql` | Tirocinium / EducationLab 共同就活データ (OB / 在校生の 2 スキーマ)。Volputas と無関係 |
| `035_ostiarius_launch_credentials.sql` | `040_ostiarius_launch_credentials.sql` | Ostiarius managed project seed + Excubitor 発行者登録。Volputas と無関係 |