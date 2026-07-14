ALTER TABLE managed_projects
  ADD COLUMN IF NOT EXISTS credential_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE project_launch_credentials
  ADD COLUMN IF NOT EXISTS client_secret_hash TEXT;

ALTER TABLE project_launch_credentials
  ADD COLUMN IF NOT EXISTS credential_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE project_launch_credentials
  ALTER COLUMN client_secret_encrypted DROP NOT NULL;

-- Revoked launch secrets are retained only as one-way verifiers. Active legacy
-- ciphertext is migrated lazily when it is presented again or replaced.
UPDATE project_launch_credentials
SET client_secret_encrypted = NULL
WHERE revoked_at IS NOT NULL;

COMMENT ON COLUMN managed_projects.credential_generation IS
  'Monotonic credential generation embedded in project JWTs and WebSocket sessions';

COMMENT ON COLUMN project_launch_credentials.client_secret_hash IS
  'One-way bcrypt verifier for launch credential idempotency; plaintext is never recoverable';

COMMENT ON COLUMN project_launch_credentials.credential_generation IS
  'Credential generation assigned when this launch became active';
