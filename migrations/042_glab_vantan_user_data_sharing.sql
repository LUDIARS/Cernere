-- GLAB は Vantan 共通プロフィールを初回登録・更新するため、必要な 3 列だけを共有する。
-- 旧 EducationLab キーとは別の現行 GLAB project credential を明示的に許可する。
UPDATE managed_projects
SET schema_definition = jsonb_set(
  schema_definition,
  '{data_sharing}',
  (
    SELECT jsonb_agg(entry)
    FROM (
      SELECT entry
      FROM jsonb_array_elements(
        COALESCE(schema_definition->'data_sharing', '[]'::jsonb)
      ) AS existing(entry)
      WHERE entry->>'project_key' <> 'glab'
      UNION ALL
      SELECT jsonb_build_object(
        'project_key', 'glab',
        'modules', jsonb_build_array('profile'),
        'columns', jsonb_build_array('name', 'role_title', 'department_name'),
        'access', 'readwrite',
        'description', 'GLAB 初回プロフィール登録に必要な最小プロフィール列を共有'
      )
    ) AS next_entries(entry)
  ),
  TRUE
),
updated_at = NOW()
WHERE key = 'vantan_user';
