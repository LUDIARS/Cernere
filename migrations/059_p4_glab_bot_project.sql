-- 認証集約 P4: GLAB の Discord bot (相談通知の巡回) を GLAB hub とは別の呼出元 project にする。
--
-- bot は GLAB hub の external API (/api/x/<module>/external/*) を呼ぶ。hub と同じ EducationLab の
-- launch credential を共有すると、Excubitor が起動ごとに client secret を再発行するため片方が失効する。
-- そこで bot 専用の project glab-bot を作り、Excubitor の catalog (GLAB 側) で
-- cernere_launch_credentials.target_project=glab-bot として起動ごとに credential を注入する (neco 判断 2026-10-05)。
--
-- | 送り側 (呼出元 key) | 受け側 (target_project_key) | scope               |
-- |---------------------|-----------------------------|---------------------|
-- | glab-bot            | EducationLab                | glab-external:write |
--
-- 058 で EducationLab に宣言した glab-external:write は bot が hub の credential を共有する前提だったもの。
-- hub が自分自身を呼ぶ経路は無いので P5 で外す (ここでは消さない)。
-- 全文冪等。既存の登録・service_scopes は消さずにマージする。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. glab-bot の最小登録。client_secret は捨て値 (起動ごとに Excubitor の launch credential で再発行される)。
--    既に登録済みなら一切上書きしない (admin が入れた定義・無効化を尊重する)。
INSERT INTO managed_projects (key, storage_slug, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'glab-bot',
    'glab_bot',
    'GLAB Bot',
    'GLAB Discord bot (consult notification scheduler).',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "glab-bot",
            "name": "GLAB Bot",
            "description": "GLAB Discord bot (consult notification scheduler)."
        },
        "data_sharing": [],
        "user_data": { "columns": {} },
        "service_scopes": ["glab-external:write"]
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- 2. 既に glab-bot が登録済みだった場合も scope を和集合で足す (058 と同じ形)。
UPDATE managed_projects
SET schema_definition = jsonb_set(
        schema_definition,
        '{service_scopes}',
        (
            SELECT COALESCE(jsonb_agg(scope ORDER BY scope), '[]'::jsonb)
            FROM (
                SELECT e #>> '{}' AS scope
                FROM jsonb_array_elements(
                    CASE jsonb_typeof(schema_definition -> 'service_scopes')
                        WHEN 'array' THEN schema_definition -> 'service_scopes'
                        ELSE '[]'::jsonb
                    END
                ) AS e
                WHERE jsonb_typeof(e) = 'string'
                UNION
                SELECT 'glab-external:write'
            ) AS all_scopes
        ),
        true
    ),
    updated_at = now()
WHERE key = 'glab-bot'
  AND jsonb_typeof(schema_definition) = 'object'
  AND NOT COALESCE(schema_definition -> 'service_scopes' @> '["glab-external:write"]'::jsonb, false);

-- 3. launch credential 発行許可 (excubitor → glab-bot)。056 と同じ形。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
SELECT 'glab-bot', 'excubitor', TRUE
WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = 'glab-bot')
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
