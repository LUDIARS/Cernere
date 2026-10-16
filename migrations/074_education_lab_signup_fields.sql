-- GLAB (managed project EducationLab) のログイン時の入力項目 — spec/plan/2026-10-15-service-signup-fields-design.md §8.4。
--
-- 名前・役職・学科は共通プロフィール vantan_user の列 (027 で EducationLab へ readwrite 共有)。
-- endpoint.frontend_url は origin からサービスを解決するため GLAB の公開 URL にする。endpoint.url は変えない。
-- 1 文の UPDATE で、EducationLab の行が無い DB では何もしない。再実行しても同じ結果になる。DROP なし。
UPDATE managed_projects
SET schema_definition = jsonb_set(
      jsonb_set(
        schema_definition,
        '{endpoint}',
        COALESCE(schema_definition->'endpoint', '{}'::jsonb) || '{"frontend_url": "https://glab.ai-run-do.com"}'::jsonb,
        TRUE
      ),
      '{signup_fields}',
      '{
        "version": 1,
        "fields": [
          {"project": "vantan_user", "column": "name", "label": "名前", "required": true, "input": "text", "max_length": 200},
          {"project": "vantan_user", "column": "role_title", "label": "役職", "required": true, "input": "text", "max_length": 200},
          {"project": "vantan_user", "column": "department_name", "label": "学科", "required": true, "input": "text", "max_length": 200}
        ]
      }'::jsonb,
      TRUE
    ),
    updated_at = now()
WHERE key = 'EducationLab';
