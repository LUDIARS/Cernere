-- Google OAuth + パスワード認証対応
-- users テーブルの拡張 + refresh_sessions テーブル追加

-- GitHub ID を nullable に変更 (Google-only ユーザー対応)
ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;

-- Google OAuth フィールド追加
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expires_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_scopes JSONB;

-- パスワード認証フィールド追加
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- メールのユニーク制約
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- ロール (admin / general)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'general';

-- 最終ログイン
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- JWT リフレッシュトークン管理 (Redis セッションと別管理)
CREATE TABLE IF NOT EXISTS refresh_sessions (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_id ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_token ON refresh_sessions(refresh_token);
