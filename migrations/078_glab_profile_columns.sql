-- Coordinated cutover: stop profile writers until GLab and Aedilis are deployed.
-- Retain the source for verification; retirement is a separate post-cutover step.
DO $$
DECLARE
  source_definition JSONB;
  destination_definition JSONB;
  profile_columns JSONB;
BEGIN
  LOCK TABLE managed_projects IN EXCLUSIVE MODE;
  SELECT schema_definition INTO source_definition FROM managed_projects
    WHERE key = 'vantan_user' AND storage_slug = 'vantan_user' AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile consolidation requires the active source registration';
  END IF;
  SELECT schema_definition INTO destination_definition FROM managed_projects
    WHERE key = 'glab' AND storage_slug = 'glab' AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile consolidation requires the active GLab registration';
  END IF;
  LOCK TABLE project_data_vantan_user, project_data_glab, user_data_optouts,
    user_service_consents IN EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(source_definition->'data_sharing', '[]'::jsonb)) grant_entry
    WHERE grant_entry->>'project_key' = 'aedilis' AND grant_entry->>'access' = 'read'
      AND grant_entry->'modules' = '["profile"]'::jsonb AND NOT (grant_entry ? 'columns')
  ) THEN RAISE EXCEPTION 'Expected source profile reader grant is missing'; END IF;
  -- No source decisions were present at preflight. Do not silently discard new ones.
  IF EXISTS (SELECT 1 FROM user_data_optouts WHERE service_id = 'vantan_user')
     OR EXISTS (SELECT 1 FROM user_service_consents
       WHERE subject_kind = 'project' AND subject_key = 'vantan_user') THEN
    RAISE EXCEPTION 'Source profile decisions require explicit reconciliation';
  END IF;
  SELECT jsonb_object_agg(key, value) INTO profile_columns
    FROM jsonb_each(source_definition #> '{user_data,columns}')
    WHERE key IN ('name', 'role_title', 'department_name', 'grade', 'desired_job');
  IF profile_columns IS NULL OR (SELECT count(*) FROM jsonb_object_keys(profile_columns)) <> 5
     OR EXISTS (SELECT 1 FROM jsonb_each(profile_columns) WHERE value->>'module' IS DISTINCT FROM 'profile') THEN
    RAISE EXCEPTION 'Unexpected source profile schema';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(profile_columns) source
    JOIN jsonb_each(COALESCE(destination_definition #> '{user_data,columns}', '{}'::jsonb)) destination USING (key)
    WHERE source.value IS DISTINCT FROM destination.value
  ) THEN RAISE EXCEPTION 'Conflicting GLab profile column definitions'; END IF;

  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS role_title TEXT;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS department_name TEXT;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS grade INTEGER;
  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS desired_job TEXT;
  IF EXISTS (
    SELECT 1 FROM project_data_vantan_user s JOIN project_data_glab d USING (user_id)
    WHERE (s.name IS NOT NULL AND d.name IS NOT NULL AND s.name <> d.name)
       OR (s.role_title IS NOT NULL AND d.role_title IS NOT NULL AND s.role_title <> d.role_title)
       OR (s.department_name IS NOT NULL AND d.department_name IS NOT NULL AND s.department_name <> d.department_name)
       OR (s.grade IS NOT NULL AND d.grade IS NOT NULL AND s.grade <> d.grade)
       OR (s.desired_job IS NOT NULL AND d.desired_job IS NOT NULL AND s.desired_job <> d.desired_job)
  ) THEN RAISE EXCEPTION 'Conflicting GLab profile values'; END IF;

  INSERT INTO project_data_glab (user_id, name, role_title, department_name, grade, desired_job, created_at, updated_at)
    SELECT user_id, name, role_title, department_name, grade, desired_job, created_at, updated_at
    FROM project_data_vantan_user
    ON CONFLICT (user_id) DO UPDATE SET
      name = COALESCE(project_data_glab.name, EXCLUDED.name),
      role_title = COALESCE(project_data_glab.role_title, EXCLUDED.role_title),
      department_name = COALESCE(project_data_glab.department_name, EXCLUDED.department_name),
      grade = COALESCE(project_data_glab.grade, EXCLUDED.grade),
      desired_job = COALESCE(project_data_glab.desired_job, EXCLUDED.desired_job);

  destination_definition := jsonb_set(destination_definition, '{user_data,columns}',
    COALESCE(destination_definition #> '{user_data,columns}', '{}'::jsonb) || profile_columns);
  -- Keep existing grants and append only the existing profile-reader permission.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(destination_definition->'data_sharing', '[]'::jsonb)) grant_entry
    WHERE grant_entry->>'project_key' = 'aedilis'
      AND grant_entry <> '{"project_key":"aedilis","modules":["profile"],"access":"read"}'::jsonb) THEN
    RAISE EXCEPTION 'Existing Aedilis grant requires explicit reconciliation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(destination_definition->'data_sharing', '[]'::jsonb)) grant_entry
    WHERE grant_entry->>'project_key' = 'aedilis') THEN
    destination_definition := jsonb_set(destination_definition, '{data_sharing}',
      COALESCE(destination_definition->'data_sharing', '[]'::jsonb)
        || '[{"project_key":"aedilis","modules":["profile"],"access":"read"}]'::jsonb);
  END IF;
  destination_definition := jsonb_set(destination_definition, '{signup_fields}', '{
    "version":2,"fields":[
      {"column":"name","label":"名前","required":true,"input":"text","max_length":200},
      {"column":"role_title","label":"役職","required":true,"input":"text","max_length":200},
      {"column":"department_name","label":"学科","required":true,"input":"text","max_length":200}
    ]}'::jsonb);
  UPDATE managed_projects SET schema_definition = destination_definition, updated_at = now()
    WHERE key = 'glab';
EXCEPTION WHEN OTHERS THEN
  -- Prevent the runner's ignored SQLSTATE list from marking a rolled-back copy applied.
  RAISE EXCEPTION 'GLab profile consolidation rolled back (SQLSTATE %)', SQLSTATE USING ERRCODE = 'P0001';
END
$$;
