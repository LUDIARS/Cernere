-- サービス初回ログイン時の権限確認 (同意) — spec/plan/2026-10-15-service-consent-design.md §5.1。
--
-- user_service_consents は利用者 × サービスの最新の同意。consent_decisions は監査 (追記のみ)。
-- 推奨の拒否は既存の user_data_optouts にも反映する (module:<key> / consent:<permission key>)。
-- subject_kind = 'project' は managed_projects.key、'oidc_client' は oidc_clients.client_id。
CREATE TABLE IF NOT EXISTS user_service_consents (
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_kind         TEXT NOT NULL CHECK (subject_kind IN ('project', 'oidc_client')),
    subject_key          TEXT NOT NULL,
    declaration_version  INTEGER NOT NULL,
    granted              JSONB NOT NULL,
    denied               JSONB NOT NULL,
    decided_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at           TIMESTAMPTZ,
    PRIMARY KEY (user_id, subject_kind, subject_key)
);

CREATE TABLE IF NOT EXISTS consent_decisions (
    id                   UUID PRIMARY KEY,
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_kind         TEXT NOT NULL,
    subject_key          TEXT NOT NULL,
    declaration_version  INTEGER NOT NULL,
    action               TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'revoke', 'update')),
    granted              JSONB NOT NULL,
    denied               JSONB NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_decisions_user ON consent_decisions (user_id, created_at);

-- OIDC client には schema_definition が無いので、移行モードと宣言を列で持つ (管理者所有)。
-- 既定 off: マージ時点で既存 RP の同意画面の動きは変わらない。
ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS consent_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS consent JSONB;
