-- ツールクライアント認証テーブル
-- 認証サーバと取り決めたシークレットでツール側から認証する
CREATE TABLE IF NOT EXISTS tool_clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    client_id       TEXT NOT NULL UNIQUE,
    client_secret_hash TEXT NOT NULL,
    owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes          JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_clients_client_id ON tool_clients (client_id);
CREATE INDEX IF NOT EXISTS idx_tool_clients_owner ON tool_clients (owner_user_id);

-- ユーザープロファイル (パーソナリティデータ)
-- 拡張データとして役割・自己紹介・得意分野・趣味などを保持
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role_title      TEXT NOT NULL DEFAULT '',
    bio             TEXT NOT NULL DEFAULT '',
    expertise       JSONB NOT NULL DEFAULT '[]'::jsonb,
    hobbies         JSONB NOT NULL DEFAULT '[]'::jsonb,
    extra           JSONB NOT NULL DEFAULT '{}'::jsonb,
    privacy         JSONB NOT NULL DEFAULT '{"bio": true, "roleTitle": true, "expertise": true, "hobbies": true}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
