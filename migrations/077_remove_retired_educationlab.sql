-- Explicit removal requested after the GLab consolidation (075/076).
-- Never mutate GLab, shared profiles or audit logs. Keep the empty legacy table
-- for migration compatibility; remove its rows and the retired registration.
DO $$
BEGIN
  LOCK TABLE managed_projects IN EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'EducationLab') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'EducationLab'
                 AND NOT is_active AND storage_slug = 'educationlab')
     OR NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'glab'
                    AND is_active AND storage_slug = 'glab') THEN
    RAISE EXCEPTION 'Retired EducationLab and active GLab are required';
  END IF;

  LOCK TABLE project_data_educationlab, project_data_glab, user_service_consents,
    user_data_optouts, project_launch_credentials, project_credential_issuers,
    edge_idp_bindings, project_oauth_tokens, enterprise_connections,
    enterprise_identities, enterprise_identity_suggestions, relay_pairs
    IN EXCLUSIVE MODE;

  -- A newer destination is legitimate; an unchanged copy must match completely.
  IF EXISTS (
    SELECT 1 FROM project_data_educationlab s
    LEFT JOIN project_data_glab d ON d.user_id = s.user_id
    WHERE d.user_id IS NULL OR d.updated_at < s.updated_at
       OR d.created_at IS DISTINCT FROM s.created_at
       OR (d.updated_at IS NOT DISTINCT FROM s.updated_at AND to_jsonb(d) <> to_jsonb(s))
  ) THEN RAISE EXCEPTION 'Unverified GLab user data copy; removal refused'; END IF;

  -- Current decisions may differ legitimately after migration (including opt-in).
  -- Never restore or compare against obsolete source decisions during deletion.
  IF NOT EXISTS (SELECT 1 FROM _migrations WHERE version = '075_consolidate_glab_registration')
     OR NOT EXISTS (SELECT 1 FROM _migrations WHERE version = '076_glab_signup_field_history') THEN
    RAISE EXCEPTION 'Recorded GLab consolidation and consent-history migration required';
  END IF;

  -- These were absent at consolidation. New integrations must not be cascaded away.
  IF EXISTS (SELECT 1 FROM edge_idp_bindings WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM project_oauth_tokens WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_connections WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_identities WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM enterprise_identity_suggestions WHERE project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM relay_pairs WHERE from_project_key = 'EducationLab' OR to_project_key = 'EducationLab')
     OR EXISTS (SELECT 1 FROM project_credential_issuers WHERE issuer_project_key = 'EducationLab'
                  OR (target_project_key = 'EducationLab' AND is_active))
     OR EXISTS (SELECT 1 FROM project_launch_credentials WHERE issuer_project_key = 'EducationLab'
                  OR (target_project_key = 'EducationLab' AND revoked_at IS NULL))
     OR EXISTS (SELECT 1 FROM managed_projects p,
                  jsonb_array_elements(COALESCE(p.schema_definition->'data_sharing', '[]'::jsonb)) grant_entry
                WHERE p.key <> 'EducationLab' AND grant_entry->>'project_key' = 'EducationLab') THEN
    RAISE EXCEPTION 'EducationLab still has integrations; removal refused';
  END IF;

  DELETE FROM project_data_educationlab;
  DELETE FROM user_data_optouts WHERE service_id = 'EducationLab';
  DELETE FROM user_service_consents WHERE subject_kind = 'project' AND subject_key = 'EducationLab';
  -- FK cascades remove only this registration's definition and credential history.
  DELETE FROM managed_projects WHERE key = 'EducationLab' AND NOT is_active;
EXCEPTION WHEN OTHERS THEN
  -- Do not allow the runner's ignorable SQLSTATE list to accept a partial cleanup.
  RAISE EXCEPTION 'EducationLab removal rolled back (SQLSTATE %)', SQLSTATE USING ERRCODE = 'P0001';
END
$$;
