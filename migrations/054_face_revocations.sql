-- 顔データの失効指示 (Ostiarius ローカル正本への削除指示)。
--
-- 顔テンプレート・顔写真の正本は施設の kiosk ホスト (Ostiarius) にあり、Cernere は
-- 同意記録と「この人の登録を消せ」という指示だけを持つ。
-- 生体情報 (テンプレート・写真・氏名) はこのテーブルに一切入れない。
--
-- user_id / facility_id に FK を張らないのは意図的。アカウント削除・施設削除自体が
-- 失効指示の発生源なので、cascade で指示が消えると Ostiarius 側に生体情報が残る。
CREATE TABLE IF NOT EXISTS face_revocations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  reason TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_face_revocations_facility_time ON face_revocations(facility_id, at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'face_revocations_reason_check'
      AND conrelid = 'face_revocations'::regclass
  ) THEN
    ALTER TABLE face_revocations
      ADD CONSTRAINT face_revocations_reason_check CHECK (reason IN (
        'withdrawn', 'left_facility', 'graduated',
        'account_deleted', 'consent_expired', 'staff_invalidated'
      ));
  END IF;
END $$;
