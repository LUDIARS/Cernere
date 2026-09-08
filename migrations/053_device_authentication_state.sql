-- Legacy Device Credentials have no verified authentication facts and must be re-enrolled.
-- These additions also support installations that applied the old #886 migration names.
ALTER TABLE device_credentials ADD COLUMN IF NOT EXISTS authentication JSONB;
ALTER TABLE device_credentials ADD COLUMN IF NOT EXISTS auth_epoch BIGINT;
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS authentication JSONB;
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS auth_epoch BIGINT NOT NULL DEFAULT 0;
-- device_credentials が (旧 #886 の別名 migration などで) 未作成の環境では、
-- FK 付き ALTER が 42P01 を投げる。 42P01 は runner が意図的にスキップしない
-- ため、 migration 全体が中断する。 参照先が在るときだけ FK を付ける。
DO $$
BEGIN
  IF to_regclass('public.device_credentials') IS NOT NULL THEN
    ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES device_credentials(id);
  ELSE
    ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS device_id UUID;
  END IF;
END $$;
ALTER TABLE registration_grants ADD COLUMN IF NOT EXISTS target_auth_epoch BIGINT;
ALTER TABLE registration_grants ADD COLUMN IF NOT EXISTS issuer_auth_epoch BIGINT;
ALTER TABLE registration_grants ADD COLUMN IF NOT EXISTS issuer_mfa_revision INTEGER;
UPDATE device_credentials SET revoked_at = now(), revoked_reason = 'key_rotation'
 WHERE revoked_at IS NULL AND (authentication IS NULL OR auth_epoch IS NULL);
