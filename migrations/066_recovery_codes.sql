-- リカバリー QR (SPEC-RECOVERY-QR / SPEC-RECOVERY-QR-USE)。
--
-- QR に載るのは乱数の recovery id と秘密値だけで、userId は載せない。
-- 秘密値は保存せず、別管理の鍵による HMAC だけを持つ。有効なコードはユーザーごとに 1 件。
CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id              TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_digest   TEXT NOT NULL,
    key_id          TEXT NOT NULL,
    generation      INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    used_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_recovery_codes_active
  ON user_recovery_codes (user_id)
  WHERE revoked_at IS NULL AND used_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_generation INTEGER NOT NULL DEFAULT 0;

-- 回復待機。新しいパスキーは passkey_candidates (purpose='recovery') に置き、
-- eligible_at 以降に新しいキー自身の assertion で確定する。待機中は旧キーで取り消せる。
CREATE TABLE IF NOT EXISTS recovery_requests (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recovery_code_id    TEXT NOT NULL REFERENCES user_recovery_codes(id),
    candidate_id        UUID NOT NULL REFERENCES passkey_candidates(id),
    auth_epoch          BIGINT NOT NULL,
    recovery_generation INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    eligible_at         TIMESTAMPTZ NOT NULL,
    cancelled_at        TIMESTAMPTZ,
    frozen_at           TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recovery_requests_open
  ON recovery_requests (user_id)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;
