-- GLab registration v3: preserve existing profiles and require an explicit membership choice.
-- Deploy the conditional-signup reader before applying this migration and the GLab gate.
DO $$
DECLARE
  definition JSONB;
BEGIN
  SELECT schema_definition INTO definition FROM managed_projects
    WHERE key = 'glab' AND storage_slug = 'glab' AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active GLab registration is required'; END IF;
  IF COALESCE((definition #>> '{signup_fields,version}')::integer, 0) > 3 THEN
    RAISE EXCEPTION 'A newer GLab signup declaration requires reconciliation';
  END IF;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS member_type TEXT;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS nickname TEXT;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS company TEXT;
  ALTER TABLE project_data_glab ALTER COLUMN department_name DROP NOT NULL;
  definition := jsonb_set(definition, '{user_data,columns}',
    COALESCE(definition #> '{user_data,columns}', '{}'::jsonb) || '{
  "member_type": {
    "type": "text",
    "module": "profile",
    "nullable": true,
    "description": "在校生 student / OB alumni"
  },
  "nickname": {
    "type": "text",
    "module": "profile",
    "nullable": true,
    "description": "任意のニックネーム"
  },
  "company": {
    "type": "text",
    "module": "profile",
    "nullable": true,
    "description": "OBの会社（任意）"
  },
  "department_name": {
    "type": "text",
    "module": "profile",
    "nullable": true,
    "description": "所属学科（在校生は必須）"
  }
}'::jsonb);
  definition := jsonb_set(definition, '{signup_fields}', '{
  "version": 3,
  "fields": [
    {
      "column": "member_type",
      "label": "在校生／OB",
      "required": true,
      "input": "tabs",
      "options": [
        {
          "value": "student",
          "label": "在校生"
        },
        {
          "value": "alumni",
          "label": "OB"
        }
      ]
    },
    {
      "column": "name",
      "label": "名前",
      "required": true,
      "input": "text",
      "max_length": 200
    },
    {
      "column": "nickname",
      "label": "ニックネーム",
      "required": false,
      "input": "text",
      "max_length": 200
    },
    {
      "column": "role_title",
      "label": "役職",
      "required": true,
      "input": "text",
      "max_length": 200
    },
    {
      "column": "department_name",
      "label": "学科",
      "required": true,
      "input": "text",
      "max_length": 200,
      "visible_when": {
        "column": "member_type",
        "value": "student"
      }
    },
    {
      "column": "grade",
      "label": "学年",
      "required": true,
      "input": "number",
      "minimum": 1,
      "visible_when": {
        "column": "member_type",
        "value": "student"
      }
    },
    {
      "column": "company",
      "label": "会社",
      "required": false,
      "input": "text",
      "max_length": 200,
      "visible_when": {
        "column": "member_type",
        "value": "alumni"
      }
    }
  ]
}'::jsonb);
  UPDATE managed_projects SET schema_definition = definition, updated_at = now() WHERE key = 'glab';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'GLab alumni registration migration rolled back (SQLSTATE %)', SQLSTATE USING ERRCODE = 'P0001';
END
$$;
