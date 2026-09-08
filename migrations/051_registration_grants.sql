-- 登録用トークン (spec/plan/passkey-default-authentication.md §7.3)。
--
-- 新規登録と手動回復の入口。 公開セルフサービス回復は設けず (§3.2 非目標)、
-- 運用者が別窓口で本人確認した上で一回限りの grant を発行する (§12.2)。
-- token 本体は保存せず SHA-256 digest のみを持つ。
CREATE TABLE IF NOT EXISTS registration_grants (
    id                 UUID PRIMARY KEY,
    purpose            TEXT NOT NULL CHECK (purpose IN
                         ('bootstrap', 'create_user', 'recover_user', 'email_enroll')),
    subject_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    pending_user_id    UUID,
    pending_webauthn_user_id TEXT,
    role               TEXT CHECK (role IN ('admin', 'general')),
    revoke_passkey_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    revoke_all_existing_passkeys BOOLEAN NOT NULL DEFAULT false,
    token_hash         TEXT NOT NULL UNIQUE,
    expires_at         TIMESTAMPTZ NOT NULL,
    used_at            TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- bootstrap / create_user はまだ存在しない user を予約する (FK にしない)。
    -- recover_user / email_enroll は既存 user を指す。
    CONSTRAINT chk_registration_grant_subject CHECK (
      (purpose IN ('bootstrap', 'create_user')
        AND subject_user_id IS NULL
        AND pending_user_id IS NOT NULL
        AND pending_webauthn_user_id IS NOT NULL)
      OR
      (purpose IN ('recover_user', 'email_enroll')
        AND subject_user_id IS NOT NULL
        AND pending_user_id IS NULL
        AND pending_webauthn_user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_registration_grants_subject
  ON registration_grants (subject_user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;
