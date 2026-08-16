-- Cernere face template canonical store. Plaintext embeddings are never persisted.
CREATE TABLE IF NOT EXISTS face_consents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL,
  facility_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_face_consents_user_facility ON face_consents(user_id, facility_id);

CREATE TABLE IF NOT EXISTS face_templates (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_enc BYTEA NOT NULL,
  key_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  quality INTEGER NOT NULL,
  version INTEGER NOT NULL,
  facility_id UUID NOT NULL REFERENCES organizations(id),
  enrolled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  consent_id UUID NOT NULL REFERENCES face_consents(id),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, facility_id)
);
CREATE INDEX IF NOT EXISTS idx_face_templates_facility_active ON face_templates(facility_id, revoked_at);

CREATE TABLE IF NOT EXISTS face_template_tombstones (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  version INTEGER NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_face_template_tombstones_facility_time ON face_template_tombstones(facility_id, revoked_at);
