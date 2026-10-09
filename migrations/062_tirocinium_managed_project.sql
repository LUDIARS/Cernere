-- Tirocinium (面接練習) を managed project として登録し、Excubitor からの launch credential 発行を許可する。
--
-- Tirocinium の Web 画面は Cernere の埋め込みログイン (composite) を使う。バックエンドは
-- project credentials で Cernere に接続して認証を代理し (CORS 回避、Actio と同じ形)、
-- ログイン後は POST /api/auth/project-token (project_key=tirocinium) で Tirocinium 向けの
-- user×project token を発行してもらう。どちらも managed_projects の行が要る (無いと拒否)。
--
-- credential は Excubitor の catalog (cernere_launch_credentials.target_project=tirocinium) で
-- 起動ごとに発行するので、client_secret はここでは使い捨ての値で埋め、issuer (excubitor) を許可する。
-- 先例: 058 (discutere の登録) + 060 (discutere の issuer grant)。
-- user_data のカラムは持たない (Tirocinium は Cernere に個人データ列を置かない)。

INSERT INTO managed_projects (key, storage_slug, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'tirocinium',
    'tirocinium',
    'Tirocinium',
    'Tirocinium interview practice service.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "tirocinium",
            "name": "Tirocinium",
            "description": "Tirocinium interview practice service."
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
VALUES ('tirocinium', 'excubitor', TRUE)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
