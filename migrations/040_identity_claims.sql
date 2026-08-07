-- Discord is an identity link for mentions and bot lookup only.  Never store
-- Discord access/refresh tokens: retaining them increases the attack surface.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_username TEXT;

-- identity_claims は managed_projects.schema_definition の管理者所有フィールド。
-- 「どのプロジェクトが users のどの identity 列を読めるか」を宣言で表す。
-- 既定は未宣言 = 読めない (fail-closed) なので、ここでの初期化は不要。
--
-- 特定サービス向けの列 (presence 等) はこのマイグレーションでは作らない。
-- サービスが managed_project.update_schema で自分の user_data.columns を宣言し、
-- schema-migrator が project_data_<key> の DDL を生成する。Cernere は個々の
-- サービスの実態を知らずに解決できること。
