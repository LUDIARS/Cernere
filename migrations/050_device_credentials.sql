-- Device Credential (spec/plan/passkey-default-authentication.md §7.2)。
--
-- パスキー認証済みの端末へ与える長期セッション資格情報。 パスキー (信頼の根) とは
-- ライフサイクルを分離し、 この行の失効で passkey 行を消してはならない (§12.1)。
-- secret は DB へ入れず、 master key 派生鍵による HMAC-SHA-256 のみ保存する (§7.5)。
CREATE TABLE IF NOT EXISTS device_credentials (
    id                       UUID PRIMARY KEY,
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    root_passkey_id          UUID REFERENCES passkeys(id) ON DELETE SET NULL,
    client_kind              TEXT NOT NULL CHECK (client_kind IN ('browser', 'native')),
    token_key_id             TEXT NOT NULL,
    generation               BIGINT NOT NULL DEFAULT 0,
    current_secret_hash      TEXT NOT NULL,
    previous_secret_hash     TEXT,
    previous_valid_until     TIMESTAMPTZ,
    last_rotation_id         UUID,
    last_rotated_at          TIMESTAMPTZ,
    expires_at               TIMESTAMPTZ NOT NULL,
    last_used_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at               TIMESTAMPTZ,
    revoked_reason           TEXT CHECK (revoked_reason IN
                              ('logout', 'replay', 'admin', 'recovery', 'passkey_revoked', 'key_rotation', 'expired')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_credentials_user_active
  ON device_credentials (user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;
