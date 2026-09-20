-- @implements SPEC-ENTERPRISE-CONNECTION / SPEC-ENTERPRISE-AUTH-FACTS
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS authentication jsonb;
CREATE TABLE IF NOT EXISTS enterprise_connections (
  project_key text PRIMARY KEY REFERENCES managed_projects(key) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  oidc_client_id text NOT NULL UNIQUE REFERENCES oidc_clients(client_id) ON DELETE CASCADE,
  team_domain text NOT NULL,
  audience text NOT NULL,
  require_mfa boolean NOT NULL DEFAULT true,
  max_authentication_age integer NOT NULL DEFAULT 3600,
  max_session_seconds integer NOT NULL DEFAULT 3600,
  is_active boolean NOT NULL DEFAULT false,
  revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS enterprise_identities (
  project_key text NOT NULL REFERENCES enterprise_connections(project_key) ON DELETE CASCADE,
  subject_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (project_key, subject_hash),
  UNIQUE (project_key, user_id)
);
