-- Renumbered from local WIP migration 035_ostiarius_launch_credentials.sql (never merged).
-- See PR: reconciliation of WIP 030-035 against merged 036_volputas_survey_responses.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (
  key,
  name,
  description,
  client_id,
  client_secret_hash,
  schema_definition
)
VALUES (
  'ostiarius',
  'Ostiarius',
  'Venue LAN attendance gateway.',
  gen_random_uuid()::text,
  crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
  '{"project":{"key":"ostiarius","name":"Ostiarius","description":"Venue LAN attendance gateway."},"data_sharing":[],"user_data":{"columns":{}}}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  schema_definition = EXCLUDED.schema_definition,
  is_active = true,
  updated_at = NOW();

INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
VALUES ('ostiarius', 'excubitor', true)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
  is_active = true,
  updated_at = NOW();
