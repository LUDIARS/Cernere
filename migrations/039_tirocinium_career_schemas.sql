-- Renumbered from local WIP migration 031_tirocinium_career_schemas.sql (never merged).
-- See PR: reconciliation of WIP 030-035 against merged 036_volputas_survey_responses.sql.

-- Tirocinium / EducationLab 共同就活データ。
-- OB と在校生は入力主体・公開範囲が異なるため別 project_data schema に分離する。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
  'tirocinium', 'Tirocinium', 'Interview and career service.',
  gen_random_uuid()::text, crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{"project":{"key":"tirocinium","name":"Tirocinium","description":"Interview and career service"},"data_sharing":[],"user_data":{"columns":{}}}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET is_active = TRUE, updated_at = now();

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
  'tirocinium_alumni_career', 'Tirocinium Alumni Career', 'OB が入力する現在の会社情報。',
  gen_random_uuid()::text, crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{
    "project":{"key":"tirocinium_alumni_career","name":"Tirocinium Alumni Career","description":"OB が入力する現在の会社情報"},
    "data_sharing":[{"project_key":"tirocinium","modules":["alumni_company"],"access":"readwrite","description":"Tr の OB 入力面で共同利用"}],
    "user_data":{"columns":{
      "company_name":{"type":"text","module":"alumni_company","nullable":false,"description":"現在の会社名"},
      "company_id":{"type":"uuid","module":"alumni_company","nullable":true,"description":"Tr 企業マスタ ID"},
      "department_name":{"type":"text","module":"alumni_company","nullable":true,"description":"部署"},
      "role_title":{"type":"text","module":"alumni_company","nullable":true,"description":"職種・役職"},
      "industry":{"type":"text","module":"alumni_company","nullable":true,"description":"業界"},
      "joined_year":{"type":"integer","module":"alumni_company","nullable":true,"description":"入社年"},
      "message_to_students":{"type":"text","module":"alumni_company","nullable":true,"description":"在校生へのメッセージ"},
      "recruitment_url":{"type":"text","module":"alumni_company","nullable":true,"description":"採用情報 URL"},
      "is_public":{"type":"boolean","module":"alumni_company","nullable":false,"default_value":"false","description":"在校生へ公開するか"}
    }}
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, schema_definition=EXCLUDED.schema_definition, is_active=TRUE, updated_at=now();

CREATE TABLE IF NOT EXISTS project_data_tirocinium_alumni_career (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT,
  company_id UUID,
  department_name TEXT,
  role_title TEXT,
  industry TEXT,
  joined_year INTEGER,
  message_to_students TEXT,
  recruitment_url TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  _deleted_columns JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
  'tirocinium_student_career', 'Tirocinium Student Career', '在校生の就活データと公開フラグ。',
  gen_random_uuid()::text, crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{
    "project":{"key":"tirocinium_student_career","name":"Tirocinium Student Career","description":"在校生の就活データと公開フラグ"},
    "data_sharing":[
      {"project_key":"tirocinium","modules":["student_career"],"access":"readwrite","description":"Tr と共同利用"},
      {"project_key":"EducationLab","modules":["student_career"],"access":"readwrite","description":"EducationLab 利用者は在校生として本人データを入力"}
    ],
    "user_data":{"columns":{
      "desired_companies":{"type":"json","module":"student_career","nullable":false,"default_value":"[]","description":"志望企業 ID と表示名"},
      "offer_companies":{"type":"json","module":"student_career","nullable":false,"default_value":"[]","description":"内定企業・職種・内定日"},
      "desired_role":{"type":"text","module":"student_career","nullable":true,"description":"希望職種"},
      "portfolio_url":{"type":"text","module":"student_career","nullable":true,"description":"ポートフォリオ URL"},
      "career_note":{"type":"text","module":"student_career","nullable":true,"description":"就活メモ"},
      "is_public":{"type":"boolean","module":"student_career","nullable":false,"default_value":"false","description":"Tr/EducationLab 内で公開するか"}
    }}
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, schema_definition=EXCLUDED.schema_definition, is_active=TRUE, updated_at=now();

CREATE TABLE IF NOT EXISTS project_data_tirocinium_student_career (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  desired_companies JSONB NOT NULL DEFAULT '[]',
  offer_companies JSONB NOT NULL DEFAULT '[]',
  desired_role TEXT,
  portfolio_url TEXT,
  career_note TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  _deleted_columns JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
