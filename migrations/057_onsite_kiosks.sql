-- 現地確認 MFA (onsite factor) の kiosk 公開鍵レジストリ。
--
-- Ostiarius kiosk が purpose:"mfa" の attestation を署名する Ed25519 公開鍵を、
-- Cernere が lan_id ごとに持つ (Ostiarius spec onsite-mfa-factor.md §0 / §4.1)。
-- Aedilis の gateway registry とは共有しない。登録は運用者 (admin) のみで、
-- Ostiarius からの自己登録はしない (service token の保持者が偽 kiosk を足せないように)。
--
-- 失効は status='revoked' の論理状態で表し、行は削除しない。
-- revoked の lan_id は再登録で active に戻さない (新しい lan_id を要求する)。
-- 顔画像・テンプレート・スコアはこのテーブルにも他のどこにも入れない。
CREATE TABLE IF NOT EXISTS onsite_kiosks (
  lan_id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  lan_url TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_onsite_kiosks_status_place ON onsite_kiosks(status, place_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'onsite_kiosks_status_check'
      AND conrelid = 'onsite_kiosks'::regclass
  ) THEN
    ALTER TABLE onsite_kiosks
      ADD CONSTRAINT onsite_kiosks_status_check CHECK (status IN ('active', 'revoked'));
  END IF;
END $$;
