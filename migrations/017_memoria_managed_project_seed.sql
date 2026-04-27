-- ─────────────────────────────────────────────────────────────────────────
-- Memoria + Imperativus を managed_projects へ seed する.
--
-- - managed_projects は通常 Cernere 管理者が WS の admin コマンド経由で
--   作成するが、自動デプロイの初期化用にこのマイグレーションで存在を
--   保証する.
-- - client_secret は migration からは復元できない random UUID を bcrypt
--   で hash した値を入れる. 運用開始前に admin が
--     POST /api/admin/projects/:key/rotate-secret
--   を叩いて plaintext を受け取り、各サービスの .env に
--     CERNERE_PROJECT_ID / CERNERE_PROJECT_SECRET
--   として配布する.
-- - imperativus 行も無ければ同時に作成 (012 で project_definitions は
--   登録済だが managed_projects への seed は無いため).
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'memoria',
    'Memoria',
    'Local-first web bookmarking & RAG. Chrome extension + Hono server + Claude CLI summarizer.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    (SELECT data_schema FROM project_definitions WHERE code = 'memoria')
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'imperativus',
    'Imperativus',
    'Voice command router — WebRTC speech input + plugin dispatch + Claude Code backend.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    (SELECT data_schema FROM project_definitions WHERE code = 'imperativus')
)
ON CONFLICT (key) DO NOTHING;
