-- 多要素認証 (MFA) 対応
-- TOTP (Google/Microsoft Authenticator), SMS (AWS SNS), メールコード (AWS SES)

-- ユーザーテーブルに MFA 関連カラム追加
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN phone_number TEXT;
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN mfa_methods JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 検証コードテーブル (SMS / メール OTP 用)
CREATE TABLE verification_codes (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    method      TEXT NOT NULL,  -- 'sms', 'email', 'totp_setup'
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_verification_codes_user_id ON verification_codes(user_id);
CREATE INDEX idx_verification_codes_lookup ON verification_codes(user_id, method, used) WHERE NOT used;

-- 期限切れコードの自動クリーンアップ用
CREATE INDEX idx_verification_codes_expires ON verification_codes(expires_at) WHERE NOT used;
