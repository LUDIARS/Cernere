-- Cernere initial schema
-- Users, projects, project settings

CREATE TABLE users (
    id          UUID PRIMARY KEY,
    github_id   BIGINT UNIQUE NOT NULL,
    login       TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url  TEXT NOT NULL,
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_user_id ON projects(user_id);

CREATE TABLE project_settings (
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    setting_key TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, setting_key)
);
