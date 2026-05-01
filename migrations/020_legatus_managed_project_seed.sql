-- ─────────────────────────────────────────────────────────────────────────
-- Legatus + Actio を managed_projects へ seed する.
--
-- 016_memoria_project_definition + 017_memoria_managed_project_seed と
-- 同じパターン。Memoria seed が memoria + imperativus を同時に入れたのと
-- 同様に、ここでは legatus + actio を同時に入れる
-- (021 で legatus ↔ actio の relay_pair を張るために双方 managed_projects
--  に存在している必要がある — relay_pairs.from/to は managed_projects(key)
--  への FK).
--
-- - managed_projects は通常 Cernere 管理者が WS の admin コマンド経由で
--   作成するが、自動デプロイの初期化用にこのマイグレーションで存在を
--   保証する。
-- - client_secret は migration からは復元できない random UUID を bcrypt
--   で hash した値を入れる。運用開始前に admin が
--     POST /api/admin/projects/:key/rotate-secret
--   を叩いて plaintext を受け取り、各サービスに以下として配布する:
--     - Legatus: OS keychain に
--         CERNERE_PROJECT_CLIENT_ID / CERNERE_PROJECT_CLIENT_SECRET
--     - Actio: Infisical の dev environment に同名キーで
-- - actio は project_definitions に行が無いため schema_definition を
--   COALESCE で空 jsonb にフォールバックする (managed_projects.schema_definition
--   は NOT NULL DEFAULT '{}'). 必要になったら別 PR で actio の
--   project_definition を追加する。
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'legatus',
    'Legatus',
    'Personal-PC service envoy. Bridges external tools (Claude Code, MCP) to LUDIARS services via Cernere PeerAdapter.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    COALESCE((SELECT data_schema FROM project_definitions WHERE code = 'legatus'), '{}'::jsonb)
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO managed_projects (key, name, description, client_id, client_secret_hash, schema_definition)
VALUES (
    'actio',
    'Actio',
    'Plugin-based event & task management platform.',
    gen_random_uuid()::text,
    crypt(gen_random_uuid()::text, gen_salt('bf', 12)),
    COALESCE((SELECT data_schema FROM project_definitions WHERE code = 'actio'), '{}'::jsonb)
)
ON CONFLICT (key) DO NOTHING;
