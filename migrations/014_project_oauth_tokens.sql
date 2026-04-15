CREATE TABLE IF NOT EXISTS project_oauth_tokens (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_key      TEXT NOT NULL,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT NOT NULL,
    access_token     TEXT,
    refresh_token    TEXT,
    expires_at       TIMESTAMPTZ,
    token_type       TEXT,
    scope            TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_key, user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_project_user
    ON project_oauth_tokens (project_key, user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_project_provider
    ON project_oauth_tokens (project_key, provider);
