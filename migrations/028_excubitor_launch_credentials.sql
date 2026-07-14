-- ExcubitorがGLAB等の起動直前にproject credentialを発行させるcontrol-plane基盤。
-- 平文secretはExが起動ごとに生成して送信し、DB履歴にはCERNERE_SECRET_KEYによる
-- AES-256-GCM暗号文だけを永続化する。managed_projectsのbcrypt hashは常に最新値へrotateする。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'excubitor',
    'Excubitor',
    'LUDIARS service launcher and operations control plane.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "excubitor",
            "name": "Excubitor",
            "description": "LUDIARS service launcher and operations control plane"
        },
        "data_sharing": [],
        "user_data": { "columns": {} }
    }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    schema_definition = EXCLUDED.schema_definition,
    is_active = TRUE,
    updated_at = now();

CREATE TABLE IF NOT EXISTS project_credential_issuers (
    target_project_key TEXT NOT NULL REFERENCES managed_projects(key) ON DELETE CASCADE,
    issuer_project_key TEXT NOT NULL REFERENCES managed_projects(key) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (target_project_key, issuer_project_key)
);
CREATE INDEX IF NOT EXISTS idx_project_credential_issuers_issuer
    ON project_credential_issuers(issuer_project_key);

CREATE TABLE IF NOT EXISTS project_launch_credentials (
    id UUID PRIMARY KEY,
    target_project_key TEXT NOT NULL REFERENCES managed_projects(key) ON DELETE CASCADE,
    issuer_project_key TEXT NOT NULL REFERENCES managed_projects(key) ON DELETE CASCADE,
    launch_id UUID NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_encrypted TEXT NOT NULL CHECK (client_secret_encrypted LIKE 'v1:%'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (issuer_project_key, target_project_key, launch_id)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_credentials_target_issued
    ON project_launch_credentials(target_project_key, issued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_launch_credentials_active_target
    ON project_launch_credentials(target_project_key) WHERE revoked_at IS NULL;

INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
VALUES ('glab', 'excubitor', TRUE)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
