-- Di -> Voluptas の収集依頼受付。export:read に書き込み権限を流用しない。
-- 既存宣言を保持し、Di の専用 scope だけを冪等に追加する。
DO $$
DECLARE
  definition jsonb;
  existing jsonb;
  merged jsonb;
BEGIN
  SELECT schema_definition INTO definition FROM managed_projects WHERE key = 'discutere' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discutere project registration is required before declaring impression request scope';
  END IF;
  IF jsonb_typeof(definition) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Discutere schema_definition must be an object';
  END IF;
  existing := COALESCE(definition -> 'service_scopes', '[]'::jsonb);
  IF jsonb_typeof(existing) <> 'array' THEN
    RAISE EXCEPTION 'Discutere service_scopes must be an array';
  END IF;
  SELECT jsonb_agg(value ORDER BY value) INTO merged
  FROM (SELECT DISTINCT value FROM jsonb_array_elements(existing || '["impression-requests:write"]'::jsonb)) AS scopes;
  IF existing IS DISTINCT FROM merged THEN
    UPDATE managed_projects
      SET schema_definition = jsonb_set(definition, '{service_scopes}', merged, true), updated_at = now()
      WHERE key = 'discutere';
  END IF;
END $$;
