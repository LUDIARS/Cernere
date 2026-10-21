-- GLab is the canonical registration (neco, 2026-10-21).
-- Copy into the existing glab identity, retaining its immutable storage_slug and credentials.
-- Keep source data and audit history for recovery. Deploy with GLab writers stopped.
-- One statement: any conflict rolls back everything, including DDL.
DO $$
DECLARE
  source_definition JSONB;
  column_names TEXT;
BEGIN
  LOCK TABLE managed_projects IN EXCLUSIVE MODE;
  SELECT schema_definition INTO source_definition FROM managed_projects
    WHERE key = 'EducationLab' AND is_active;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'glab' AND storage_slug = 'glab')
     OR NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'EducationLab' AND storage_slug = 'educationlab') THEN
    RAISE EXCEPTION 'GLab consolidation requires the expected source and destination registrations';
  END IF;

  LOCK TABLE project_data_glab, project_data_educationlab, user_data_optouts,
    user_service_consents IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM project_data_glab) THEN
    RAISE EXCEPTION 'GLab destination contains data; explicit conflict resolution is required';
  END IF;
  IF EXISTS (SELECT 1 FROM user_service_consents WHERE subject_kind = 'project' AND subject_key = 'glab') THEN
    RAISE EXCEPTION 'GLab destination has consent decisions; explicit reconciliation is required';
  END IF;
  -- These integrations are absent in the deployment inspected for this migration.
  -- Do not silently abandon one if it appeared after inspection.
  IF EXISTS (SELECT 1 FROM edge_idp_bindings WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_connections WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_identities WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_identity_suggestions WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM project_oauth_tokens WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM relay_pairs WHERE from_project_key = 'EducationLab' OR to_project_key = 'EducationLab') THEN
    RAISE EXCEPTION 'EducationLab has additional integrations requiring explicit migration';
  END IF;

  ALTER TABLE project_data_glab ADD COLUMN IF NOT EXISTS current_location TEXT;
  -- Preserve every source column, including timestamps and deleted-column metadata.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns s
    LEFT JOIN information_schema.columns d ON d.table_schema = s.table_schema
      AND d.table_name = 'project_data_glab' AND d.column_name = s.column_name
      AND d.udt_name = s.udt_name
    WHERE s.table_schema = 'public' AND s.table_name = 'project_data_educationlab'
      AND d.column_name IS NULL
  ) THEN RAISE EXCEPTION 'GLab data schemas differ; refusing partial copy'; END IF;
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO column_names FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_data_educationlab';
  EXECUTE format('INSERT INTO project_data_glab (%s) SELECT %s FROM project_data_educationlab', column_names, column_names);

  INSERT INTO user_data_optouts (user_id, service_id, category_key, opted_out_at)
    SELECT user_id, 'glab', category_key, opted_out_at FROM user_data_optouts WHERE service_id = 'EducationLab'
    ON CONFLICT (user_id, service_id, category_key) DO NOTHING;
  INSERT INTO user_service_consents
    (user_id, subject_kind, subject_key, declaration_version, granted, denied, decided_at, revoked_at)
    SELECT user_id, subject_kind, 'glab', declaration_version, granted, denied, decided_at, revoked_at
    FROM user_service_consents WHERE subject_kind = 'project' AND subject_key = 'EducationLab';

  UPDATE managed_projects SET
    name = 'GLab', description = 'GLab operations hub', is_active = TRUE,
    schema_definition = jsonb_set(jsonb_set(jsonb_set(source_definition,
      '{project,key}', '"glab"'::jsonb), '{project,name}', '"GLab"'::jsonb),
      '{endpoint,bridge_path}', '"/glab"'::jsonb), updated_at = now()
    WHERE key = 'glab';

  -- Transfer existing upstream data grants without broadening their columns/access.
  UPDATE managed_projects p SET schema_definition = jsonb_set(p.schema_definition, '{data_sharing}', (
    SELECT jsonb_agg(CASE WHEN entry->>'project_key' = 'EducationLab'
      THEN jsonb_set(entry, '{project_key}', '"glab"'::jsonb) ELSE entry END)
    FROM jsonb_array_elements(p.schema_definition->'data_sharing') entry
    WHERE entry->>'project_key' IS DISTINCT FROM 'glab'
  )), updated_at = now()
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.schema_definition->'data_sharing', '[]'::jsonb)) entry
    WHERE entry->>'project_key' = 'EducationLab');

  INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
    SELECT 'glab', issuer_project_key, is_active FROM project_credential_issuers WHERE target_project_key = 'EducationLab'
    ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = now();
  UPDATE project_credential_issuers SET is_active = FALSE, updated_at = now()
    WHERE target_project_key = 'EducationLab';
  UPDATE project_launch_credentials SET revoked_at = COALESCE(revoked_at, now())
    WHERE target_project_key IN ('EducationLab', 'glab');
  UPDATE managed_projects SET is_active = FALSE, updated_at = now() WHERE key = 'EducationLab';
EXCEPTION WHEN OTHERS THEN
  -- The migration runner ignores some SQLSTATEs (e.g. unique violations).
  -- Convert every failure so it cannot mark an aborted consolidation as applied.
  RAISE EXCEPTION 'GLab consolidation rolled back (SQLSTATE %)', SQLSTATE USING ERRCODE = 'P0001';
END
$$;
