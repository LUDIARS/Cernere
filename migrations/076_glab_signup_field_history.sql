-- Migration 075 preserved consent decisions but omitted signup-field acknowledgements.
-- Only backfill untouched destination history after the source has been retired.
-- Never overwrite a subsequent GLab submission or copy across different decisions.
UPDATE user_service_consents AS destination
SET fields_version = source.fields_version,
    fields_seen = source.fields_seen
FROM user_service_consents AS source
WHERE source.subject_kind = 'project'
  AND source.subject_key = 'EducationLab'
  AND destination.subject_kind = source.subject_kind
  AND destination.subject_key = 'glab'
  AND destination.user_id = source.user_id
  AND destination.fields_version IS NULL
  AND destination.fields_seen IS NULL
  AND destination.declaration_version IS NOT DISTINCT FROM source.declaration_version
  AND destination.granted IS NOT DISTINCT FROM source.granted
  AND destination.denied IS NOT DISTINCT FROM source.denied
  AND destination.decided_at IS NOT DISTINCT FROM source.decided_at
  AND destination.revoked_at IS NOT DISTINCT FROM source.revoked_at
  AND EXISTS (SELECT 1 FROM managed_projects WHERE key = 'EducationLab' AND NOT is_active)
  AND EXISTS (SELECT 1 FROM managed_projects WHERE key = 'glab' AND is_active);
