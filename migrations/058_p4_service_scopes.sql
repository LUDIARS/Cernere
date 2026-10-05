-- 認証集約 P4 (Corpus spec/plan/auth-plane-consolidation.md §6) の Cernere 側。
-- 固定トークンを Cernere service token (spec/feature/service-token.md) へ載せ替えるため、
-- 呼出元 project の service_scopes を宣言し、未登録の呼出先 / 呼出元を最小限登録する。
--
-- | 送り側 (呼出元 key)        | 受け側 (target_project_key) | scope                 |
-- |----------------------------|-----------------------------|-----------------------|
-- | GLAB bot (EducationLab)    | EducationLab                | glab-external:write   |
-- | GLAB connector (EducationLab) | calliope                 | calliope-api:access   |
-- | Calliope (calliope)        | EducationLab                | glab-external:write   |
-- | Volputas (volputas)        | discutere                   | persona-bridge:write  |
-- | Discutere (discutere)      | volputas                    | persona-export:read   |
--
-- 全文冪等。既存の登録・service_scopes は消さずにマージする。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Calliope / Discutere の最小登録。
--    service token の aud (= storage_slug) 解決と、呼出元としての client credentials 保持に要る。
--    client_secret は捨て値 (起動ごとに Excubitor の launch credential で再発行される)。
--    既に登録済みなら一切上書きしない (admin が入れた定義・無効化を尊重する)。
INSERT INTO managed_projects (key, storage_slug, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'calliope',
    'calliope',
    'Calliope',
    'Calliope project progress and service map hub.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "calliope",
            "name": "Calliope",
            "description": "Calliope project progress and service map hub."
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO managed_projects (key, storage_slug, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'discutere',
    'discutere',
    'Discutere',
    'Discutere persona discussion service.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "discutere",
            "name": "Discutere",
            "description": "Discutere persona discussion service."
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- 2. service_scopes 宣言 (管理者所有フィールド)。
--    既存配列の要素 (文字列のみ) と和集合を取り、重複除去・昇順で書き戻す。
--    未登録 key は UPDATE 0 行で素通りする (登録は上の INSERT か admin の責務)。
DO $$
DECLARE
  grant_row RECORD;
  current_def JSONB;
  existing JSONB;
  merged JSONB;
BEGIN
  FOR grant_row IN
    SELECT project_key, array_agg(scope) AS scopes
    FROM (VALUES
      ('EducationLab', 'glab-external:write'),
      ('EducationLab', 'calliope-api:access'),
      ('calliope',     'glab-external:write'),
      ('volputas',     'persona-bridge:write'),
      ('discutere',    'persona-export:read')
    ) AS declared(project_key, scope)
    GROUP BY project_key
  LOOP
    SELECT schema_definition INTO current_def
    FROM managed_projects
    WHERE key = grant_row.project_key
    FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF current_def IS NULL OR jsonb_typeof(current_def) <> 'object' THEN
      RAISE EXCEPTION 'managed_projects.schema_definition of % is not an object', grant_row.project_key;
    END IF;

    existing := CASE jsonb_typeof(current_def -> 'service_scopes')
      WHEN 'array' THEN current_def -> 'service_scopes'
      WHEN 'string' THEN jsonb_build_array(current_def -> 'service_scopes')
      ELSE '[]'::jsonb
    END;

    SELECT COALESCE(jsonb_agg(scope ORDER BY scope), '[]'::jsonb) INTO merged
    FROM (
      SELECT e #>> '{}' AS scope
      FROM jsonb_array_elements(existing) AS e
      WHERE jsonb_typeof(e) = 'string'
      UNION
      SELECT unnest(grant_row.scopes)
    ) AS all_scopes;

    IF merged IS DISTINCT FROM current_def -> 'service_scopes' THEN
      UPDATE managed_projects
      SET schema_definition = jsonb_set(current_def, '{service_scopes}', merged, true),
          updated_at = now()
      WHERE key = grant_row.project_key;
    END IF;
  END LOOP;
END $$;

-- 3. launch credential 発行許可 (excubitor → 送り側)。056 と同じ形。
--    EducationLab (044) / volputas (036) は既存。新たに送り側になる calliope / discutere を足す。
--    1. の INSERT が storage_slug 衝突等で skip された場合に FK 違反で止めないよう存在を条件にする。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
SELECT 'calliope', 'excubitor', TRUE
WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = 'calliope')
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();

INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
SELECT 'discutere', 'excubitor', TRUE
WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = 'discutere')
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
