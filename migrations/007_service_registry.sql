-- Service Registry: Cernere に WebSocket 接続するサービスの登録
-- Service Tickets: 3点方式認証のワンタイムチケット

CREATE TABLE service_registry (
    id                UUID PRIMARY KEY,
    code              TEXT UNIQUE NOT NULL,
    name              TEXT NOT NULL,
    service_secret_hash TEXT NOT NULL,
    endpoint_url      TEXT NOT NULL,
    scopes            JSONB NOT NULL DEFAULT '[]',
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    last_connected_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_tickets (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES service_registry(id) ON DELETE CASCADE,
    ticket_code     TEXT UNIQUE NOT NULL,
    user_data       JSONB NOT NULL,
    organization_id UUID,
    scopes          JSONB NOT NULL DEFAULT '[]',
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_tickets_code ON service_tickets(ticket_code);
CREATE INDEX idx_service_tickets_expires ON service_tickets(expires_at) WHERE NOT consumed;
