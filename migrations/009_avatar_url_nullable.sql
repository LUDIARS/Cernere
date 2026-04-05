-- avatar_url を nullable に変更
ALTER TABLE users ALTER COLUMN avatar_url DROP NOT NULL;
ALTER TABLE users ALTER COLUMN avatar_url SET DEFAULT NULL;
