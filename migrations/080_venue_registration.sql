-- 会場ネットワーク限定の新規登録 (spec/feature/venue-network-registration.md §5)。
--
-- 登録画面が発行する venue challenge。nonce は SHA-256 で保存し、平文は発行応答だけで返す。
-- Ostiarius kiosk の purpose:"registration" attestation を受理すると verified_at・lan_id・place_id を記録し、
-- パスキー signup が同じトランザクションで consumed_at を記録して一度だけ使う。
-- 期限切れの行は 1 日で回収する (auth/venue-registration-sweeper.ts)。
CREATE TABLE IF NOT EXISTS venue_registration_challenges (
  id UUID PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  lan_id TEXT,
  place_id TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_registration_challenges_expires ON venue_registration_challenges(expires_at);

-- 登録の経路。venue = 会場 LAN 経由 / outside_venue = 会場外 (例外) / NULL = 本機能以前の登録。
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_origin TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_place_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_users_registration_origin'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_registration_origin
      CHECK (registration_origin IS NULL OR registration_origin IN ('venue', 'outside_venue'));
  END IF;
END $$;
