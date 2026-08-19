-- プロフィール顔写真の封緘保存と、写真由来テンプレートの審査状態。
--
-- 写真は表示用に長辺 1024 / JPEG へ正規化した 1 人 1 枚のみを AES-256-GCM で
-- 封緘して保持する。テンプレート鍵とは別鍵 (key_id) を使い、鍵が無ければ
-- 写真経路全体を fail closed にする。
-- face_templates.state は照合配布の可否を決める。写真から自動抽出した
-- テンプレートは必ず 'pending' で入り、職員の promote を経るまで export に
-- 出さない (= 照合経路に乗らない)。

CREATE TABLE IF NOT EXISTS face_photos (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  tag BYTEA NOT NULL,
  key_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  consent_id UUID NOT NULL REFERENCES face_consents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_face_photos_consent ON face_photos(consent_id);

ALTER TABLE face_templates
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';

-- 既存行は職員登録済みのテンプレートなので 'active' で backfill する。
UPDATE face_templates SET state = 'active' WHERE state IS NULL OR state NOT IN ('pending', 'active', 'revoked');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'face_templates_state_check'
      AND conrelid = 'face_templates'::regclass
  ) THEN
    ALTER TABLE face_templates
      ADD CONSTRAINT face_templates_state_check CHECK (state IN ('pending', 'active', 'revoked'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_face_templates_facility_state ON face_templates(facility_id, state);
