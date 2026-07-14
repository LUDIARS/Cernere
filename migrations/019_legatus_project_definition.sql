-- Legatus プロジェクト定義
-- 個人 PC 常駐の LUDIARS サービス代理人 (Service Envoy)。
-- 外部ツール (Claude Code 等) から MCP / POST API で命令を受け取り、
-- Cernere PeerAdapter 経由で各サービス (Actio / Memoria / Calicula 等) を
-- ユーザの代理として呼び出す。Legatus 自身はデータを持たず、
-- Cernere ユーザセッションのトークンのみローカル暗号化保管する。
--
-- 冪等: ON CONFLICT で既存行はスキップする。

INSERT INTO project_definitions (id, code, name, data_schema, commands, plugin_repository)
VALUES (
    'c3d4e5f6-789a-4bcd-ef01-234567890abc',
    'legatus',
    'Legatus — Personal-PC service envoy',
    '{
        "type": "object",
        "description": "Per-user Legatus preferences (settings synced across the user''s personal PCs). Bookmark-equivalent state (sessions, tokens, audit logs) lives encrypted on each PC and is not synced via Cernere."
    }'::jsonb,
    '[
        {
            "code": "ping",
            "name": "Ping",
            "description": "Connectivity check. Echoes payload."
        }
    ]'::jsonb,
    'https://github.com/LUDIARS/Legatus'
)
ON CONFLICT (code) DO NOTHING;
