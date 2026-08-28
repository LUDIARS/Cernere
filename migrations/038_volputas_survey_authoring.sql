-- Renumbered from local WIP migration 030_volputas_survey_authoring.sql (never merged).
-- See PR: reconciliation of WIP 030-035 against merged 036_volputas_survey_responses.sql.

-- Volputas のアンケート作成権限を Cernere user_id 単位で一元管理する。
-- EducationLab は survey_authoring module を読み取るだけで、権限値を自前 DB に複製しない。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'volputas_users',
    'Volputas Users',
    'Volputas アンケート機能のユーザー別権限。',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "volputas_users",
            "name": "Volputas Users",
            "description": "Volputas アンケート機能のユーザー別権限"
        },
        "data_sharing": [
            {
                "project_key": "EducationLab",
                "modules": ["survey_authoring"],
                "access": "read",
                "description": "EducationLab がログインユーザーのアンケート作成権限を判定する"
            }
        ],
        "user_data": {
            "columns": {
                "can_create_surveys": {
                    "type": "boolean",
                    "module": "survey_authoring",
                    "nullable": false,
                    "default_value": "false",
                    "description": "アンケートを作成できるか"
                }
            }
        }
    }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    schema_definition = EXCLUDED.schema_definition,
    is_active = TRUE,
    updated_at = now();

CREATE TABLE IF NOT EXISTS project_data_volputas_users (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_create_surveys BOOLEAN NOT NULL DEFAULT FALSE,
    _deleted_columns JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);

ALTER TABLE project_data_volputas_users
    ADD COLUMN IF NOT EXISTS can_create_surveys BOOLEAN NOT NULL DEFAULT FALSE;
