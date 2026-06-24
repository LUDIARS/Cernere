-- 025: Memoria data_schema 旧形式の論理無効化
--
-- 背景:
--   migration 016 が project_definitions.data_schema に旧世代の JSON-schema-of-prefs
--   形式 (type/properties/enum 等の object スキーマ) を格納した。
--   現行の列生成機構 (Zod ProjectDefinition の user_data.columns →
--   migrateProjectSchema) はこの形式を一切参照せず、schema フィールドは
--   Memoria にとって死んだデータとして混乱の元となっている。
--   Memoria はローカルツールであり Cernere の project_data を直接使用しないため、
--   この旧 schema を空 jsonb で上書きし論理的に無効化する。
--
-- 対象: project_definitions.data_schema (code = "memoria") のみ
-- 非対象: managed_projects の memoria 行 / 認証登録 / その他列
--
-- 冪等性: UPDATE は何度実行しても '{}'::jsonb への収束のみであり安全。

UPDATE project_definitions
SET    data_schema = '{}'::jsonb
WHERE  code = 'memoria';
