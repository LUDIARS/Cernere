-- ログイン通知 (SPEC-LOGIN-ALERT)。
--
-- 出来事は成功トランザクションの中で security_events と notification_outbox に記録し、
-- worker が配送する。送信失敗でログインを止めず、記録の欠落も起こさない。
CREATE TABLE IF NOT EXISTS security_events (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('normal', 'high', 'critical')),
    -- 表示用の概略 (ブラウザ/OS、国、期限など)。秘密値・完全な IP・userId は入れない。
    detail          JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user
  ON security_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
    id              UUID PRIMARY KEY,
    event_id        UUID NOT NULL REFERENCES security_events(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('relay', 'discord', 'google')),
    -- 出来事が起きた時点の宛先 (通知先の変更前の宛先にも届けるため、行ごとに固定する)。
    target_ref      TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    leased_until    TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    failed_at       TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

-- 通知先。到達を確認できたもの (verified_at) だけに配送する。
-- address は Discord なら連携済み discord_id、Google なら連携時に検証済みのメールアドレス。
CREATE TABLE IF NOT EXISTS login_alert_targets (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel             TEXT NOT NULL CHECK (channel IN ('discord', 'google')),
    address             TEXT NOT NULL,
    verification_digest TEXT,
    verification_expires_at TIMESTAMPTZ,
    verification_attempts INTEGER NOT NULL DEFAULT 0,
    verified_at         TIMESTAMPTZ,
    degraded_at         TIMESTAMPTZ,
    removed_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_login_alert_targets_active
  ON login_alert_targets (user_id, channel)
  WHERE removed_at IS NULL;

-- Google 連携時に Google が検証したアドレス。通知先として本人が有効にしたときだけ使い、
-- ログインの識別子や users.email (MFA 用) には使わない。連携解除で消す。
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified_email TEXT;
