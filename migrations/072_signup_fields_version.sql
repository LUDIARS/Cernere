-- サービス経由ログイン時の入力項目 (signup_fields) — spec/plan/2026-10-15-service-signup-fields-design.md §5。
--
-- fields_version: 入力項目を画面で見せた宣言の版。NULL = まだ見せていない。
--   同じ版では空のまま進んだ任意項目を再表示しない。版が上がったら未入力の新項目だけ聞く。
-- fields_seen: その版で見せた列 (版上げ時に「新項目」を見分けるため)。
-- 値そのものは既存の project_data_<storage_slug> に書く。DROP なし。
ALTER TABLE user_service_consents ADD COLUMN IF NOT EXISTS fields_version INTEGER;
ALTER TABLE user_service_consents ADD COLUMN IF NOT EXISTS fields_seen JSONB;
