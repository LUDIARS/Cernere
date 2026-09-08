-- Persistent TOTP replay prevention and invalidation of pending MFA settings.
-- @implements SPEC-MFA-TOTP / SPEC-MFA-SETTINGS
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_revision integer NOT NULL DEFAULT 0;
