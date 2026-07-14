-- ─────────────────────────────────────────────────────────────────────────
-- Ludellus を managed_projects へ seed + project_data_ludellus を生成する。
--
-- 用途: 跨セッションのプレイヤー顔識別 (roster 限定 1:N)。各ユーザの顔識別
--       テンプレ(embedding)を本人行の biometric_face 列に保管する。
--       生体センシティブデータ:
--         - module = "biometric" 単位で opt-out 可能 (user_data_optouts)。
--         - 保管するのは embedding のみ。生の顔画像は一切保存しない。
--         - 照合は roster(セッション参加者) 限定。グローバル生体DBは作らない。
--
-- schema_definition は **現行の zod ProjectDefinition (columns 形式)** を使う。
-- 旧 data_schema 形式 (memoria/legatus の {type:"object", ...}) は
-- user_data.columns を持たず project_data_<key> 列を一切生成しないため使わない
-- (server/src/project/schema-migrator.ts / ensureUserProjectRow を参照)。
--
-- - client_secret は migration から復元できない random UUID を bcrypt で hash。
--   運用開始前に server/ で
--     npx tsx scripts/rotate-project-secret.ts --project ludellus
--   を実行して plaintext を一度だけ受け取り、Ludellus 側へ配布。
-- - project_data_ludellus は runtime の register/update_schema(migrateProjectSchema)
--   が生成するテーブルと同形を、admin 操作を待たず冪等に先行生成する。
--   admin が後で同一定義で register しても IF NOT EXISTS で安全。
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'ludellus',
    'Ludellus',
    'Educational MMO / MR (AR-Menco) client. Stores per-user face-identity templates (roster-bound cross-session recognition) in the user''s own row.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    '{
        "project": {
            "key": "ludellus",
            "name": "Ludellus",
            "description": "知育 MMO / MR(AR-Menco) クライアント。跨セッションのプレイヤー顔識別テンプレを本人行に保管する。"
        },
        "user_data": {
            "columns": {
                "biometric_face": {
                    "type": "json",
                    "module": "biometric",
                    "nullable": true,
                    "description": "顔識別テンプレ { model, embeddings: number[][], updated_at }。roster 限定 1:N 照合用。生画像は保存せず embedding のみ。biometric module の opt-out で削除可。"
                }
            }
        }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- migrateProjectSchema(server/src/project/schema-migrator.ts) と同形のテーブルを
-- 冪等生成する。列構成: user_id(PK,FK) + 定義カラム + _deleted_columns/created_at/updated_at。
CREATE TABLE IF NOT EXISTS "project_data_ludellus" (
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "biometric_face" JSONB,
    _deleted_columns JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);
