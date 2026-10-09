CREATE TABLE IF NOT EXISTS workload_principals (
  id TEXT PRIMARY KEY,
  client_id UUID NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS workload_keys (
  id UUID PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE REFERENCES workload_principals(id),
  public_key_pem TEXT NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS workload_grants (
  id UUID PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES workload_principals(id),
  audience TEXT NOT NULL REFERENCES workload_principals(id),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  keys JSONB,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS workload_grants_active_unique
  ON workload_grants(subject, audience, action, resource) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS workload_tokens (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL REFERENCES workload_principals(id),
  audience TEXT NOT NULL REFERENCES workload_principals(id),
  key_id UUID NOT NULL REFERENCES workload_keys(id),
  grant_id UUID NOT NULL REFERENCES workload_grants(id),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT workload_token_ttl CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds')
);
