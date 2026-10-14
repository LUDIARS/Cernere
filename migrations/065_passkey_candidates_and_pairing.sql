-- パスキーのみ認証 (spec/plan/2026-10-14-passkey-only-authentication.md §4 / §5)。
--
-- 承認待ちのパスキー。UV 済みの登録結果を保存するが、passkeys へ移すまで
-- ログイン・action proof には使えない。端末追加 (pairing) とリカバリー QR の
-- 回復待機が使う。既存の passkeys の有効判定 (revoked_at IS NULL) は変えない。
CREATE TABLE IF NOT EXISTS passkey_candidates (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose         TEXT NOT NULL CHECK (purpose IN ('pairing', 'recovery')),
    credential_id   TEXT NOT NULL,
    public_key      BYTEA NOT NULL,
    counter         BIGINT NOT NULL DEFAULT 0,
    device_type     TEXT NOT NULL DEFAULT 'singleDevice',
    backed_up       BOOLEAN NOT NULL DEFAULT false,
    transports      JSONB NOT NULL DEFAULT '[]',
    aaguid          TEXT,
    nickname        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_at     TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_passkey_candidates_credential
  ON passkey_candidates (credential_id);

CREATE INDEX IF NOT EXISTS idx_passkey_candidates_user_open
  ON passkey_candidates (user_id, created_at DESC)
  WHERE promoted_at IS NULL AND revoked_at IS NULL;

-- 別端末の追加 (SPEC-DEVICE-PAIRING)。QR の token は digest だけを保存する。
-- 候補が付いたら元端末が照合番号を確かめて承認するまで有効化しない。
CREATE TABLE IF NOT EXISTS device_pairings (
    id                    UUID PRIMARY KEY,
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_digest          TEXT NOT NULL,
    auth_epoch            BIGINT NOT NULL,
    expires_at            TIMESTAMPTZ NOT NULL,
    claimed_at            TIMESTAMPTZ,
    candidate_id          UUID REFERENCES passkey_candidates(id) ON DELETE SET NULL,
    match_code            TEXT,
    match_attempts        INTEGER NOT NULL DEFAULT 0,
    candidate_label       TEXT,
    approved_at           TIMESTAMPTZ,
    rejected_at           TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_pairings_token
  ON device_pairings (token_digest);

CREATE INDEX IF NOT EXISTS idx_device_pairings_user
  ON device_pairings (user_id, created_at DESC);
