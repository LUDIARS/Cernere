-- OIDC Clients: Cernere を OpenID Connect IdP とする RP (Cloudflare Access 等) の登録
CREATE TABLE IF NOT EXISTS oidc_clients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           TEXT NOT NULL UNIQUE,
    client_secret_hash  TEXT NOT NULL,
    name                TEXT NOT NULL,
    redirect_uris       JSONB NOT NULL DEFAULT '[]',
    scopes              JSONB NOT NULL DEFAULT '["openid","email","profile"]',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES users (id) ON DELETE SET NULL,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oidc_clients_client_id ON oidc_clients (client_id);
