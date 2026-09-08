-- users / passkeys の追加列 (spec/plan/passkey-default-authentication.md §7.1)。
--
-- auth_epoch は回復・全端末失効で increment し、 旧 access token / WS session を
-- まとめて無効化する。 passkeys の削除は hard delete をやめ revoked_at による
-- 論理失効へ移す (監査と失効連動のため行を残す)。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS webauthn_user_id TEXT;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_epoch BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_webauthn_user_id
  ON users (webauthn_user_id)
  WHERE webauthn_user_id IS NOT NULL;

ALTER TABLE passkeys
  ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE passkeys
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_passkeys_user_active
  ON passkeys (user_id, created_at)
  WHERE revoked_at IS NULL;

-- 既存 passkey を持つ user の user handle は変えない。 現行実装は WebAuthn userID に
-- users.id の UTF-8 byte 列を使っているため、 その base64url を backfill する。
-- passkey を持たない user は NULL のままにし、 新規登録時に 32 byte 乱数を割り当てる。
UPDATE users u
   SET webauthn_user_id = translate(encode(convert_to(u.id::text, 'UTF8'), 'base64'), '+/=', '-_')
 WHERE u.webauthn_user_id IS NULL
   AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id);
