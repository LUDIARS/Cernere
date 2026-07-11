-- GLAB の Cernere project 登録と、共通 Vantan profile schema の更新。
-- 個人プロフィールは GLAB DB に複製せず project_data_vantan_user を単一情報源にする。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'glab',
    'GLAB',
    'Vantan Game Academy GLAB operations hub.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "glab",
            "name": "GLAB",
            "description": "Vantan Game Academy GLAB operations hub."
        },
        "endpoint": {
            "url": "http://localhost:5187",
            "frontend_url": "http://localhost:5187",
            "same_server": true,
            "bridge_path": "/glab"
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    schema_definition = EXCLUDED.schema_definition,
    is_active = TRUE,
    updated_at = now();

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'vantan_user',
    'Vantan User Profile',
    'Vantan 共通プロフィール。氏名・役職・所属学科を必須情報として Cernere に一元保管する。',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "vantan_user",
            "name": "Vantan User Profile",
            "description": "氏名・役職・所属学科などの Vantan 共通プロフィール"
        },
        "data_sharing": [
            {
                "project_key": "aedilis",
                "modules": ["profile"],
                "access": "read",
                "description": "施設予約・出席記録のためプロフィールを読み取り専用で共有"
            },
            {
                "project_key": "glab",
                "modules": ["profile"],
                "access": "readwrite",
                "description": "GLAB 初回アクセス時のプロフィール登録と運営表示に使用"
            }
        ],
        "user_data": {
            "columns": {
                "name": {
                    "type": "text",
                    "module": "profile",
                    "nullable": false,
                    "description": "氏名"
                },
                "role_title": {
                    "type": "text",
                    "module": "profile",
                    "nullable": false,
                    "description": "役職"
                },
                "department_name": {
                    "type": "text",
                    "module": "profile",
                    "nullable": false,
                    "description": "所属学科"
                },
                "grade": {
                    "type": "integer",
                    "module": "profile",
                    "nullable": true,
                    "description": "学年"
                },
                "desired_job": {
                    "type": "text",
                    "module": "profile",
                    "nullable": true,
                    "description": "希望職種"
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

CREATE TABLE IF NOT EXISTS project_data_vantan_user (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    role_title TEXT,
    department_name TEXT,
    grade INTEGER,
    desired_job TEXT,
    _deleted_columns JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);

ALTER TABLE project_data_vantan_user ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE project_data_vantan_user ADD COLUMN IF NOT EXISTS role_title TEXT;
ALTER TABLE project_data_vantan_user ADD COLUMN IF NOT EXISTS department_name TEXT;
ALTER TABLE project_data_vantan_user ADD COLUMN IF NOT EXISTS grade INTEGER;
ALTER TABLE project_data_vantan_user ADD COLUMN IF NOT EXISTS desired_job TEXT;

-- 既存の未登録行を保持したまま、必須性は schema と GLAB 登録フォームで強制する。
ALTER TABLE project_data_vantan_user ALTER COLUMN name DROP NOT NULL;
ALTER TABLE project_data_vantan_user ALTER COLUMN role_title DROP NOT NULL;
ALTER TABLE project_data_vantan_user ALTER COLUMN department_name DROP NOT NULL;
ALTER TABLE project_data_vantan_user ALTER COLUMN grade DROP NOT NULL;
