-- Memoria プロジェクト定義
-- ローカル動作の Web ブックマーキング & RAG ツール。Chrome 拡張から保存、
-- Claude Code CLI で要約 + カテゴリ生成、保存済資産に対する意味検索/Q&A、
-- 「ディグる」 (deep research)、関連サイト推薦などを提供する。
--
-- 冪等: ON CONFLICT で既存行はスキップする。

INSERT INTO project_definitions (id, code, name, data_schema, commands, plugin_repository)
VALUES (
    'b2c3d4e5-6789-4abc-def0-123456789abc',
    'memoria',
    'Memoria — Local-first web bookmarking & RAG',
    '{
        "type": "object",
        "description": "Per-user Memoria preferences stored in Cernere. Bookmark bodies and personal HTML stay on the Memoria server itself; this schema only holds settings the user wants synced across devices.",
        "properties": {
            "ui": {
                "type": "object",
                "description": "Memoria web UI preferences",
                "properties": {
                    "default_tab": {
                        "type": "string",
                        "enum": ["bookmarks", "queue", "visits", "trends", "recommend", "rag", "dig"],
                        "default": "bookmarks"
                    },
                    "default_sort": {
                        "type": "string",
                        "enum": ["created_desc", "created_asc", "accessed_desc", "accessed_asc", "title_asc"],
                        "default": "created_desc"
                    },
                    "show_floating_button": { "type": "boolean", "default": true }
                }
            },
            "extension": {
                "type": "object",
                "description": "Chrome extension preferences",
                "properties": {
                    "disable_tracking":   { "type": "boolean", "default": false },
                    "button_position":    {
                        "type": "object",
                        "properties": {
                            "right":  { "type": "integer", "minimum": 0, "default": 24 },
                            "bottom": { "type": "integer", "minimum": 0, "default": 24 }
                        }
                    }
                }
            },
            "rag": {
                "type": "object",
                "description": "Semantic search / Q&A preferences",
                "properties": {
                    "enabled":          { "type": "boolean", "default": true },
                    "default_top_k":    { "type": "integer", "minimum": 1, "maximum": 20, "default": 6 },
                    "auto_backfill":    { "type": "boolean", "default": false }
                }
            },
            "filters": {
                "type": "object",
                "description": "Per-user NG additions on top of server defaults",
                "properties": {
                    "extra_ng_words":   { "type": "array", "items": { "type": "string" }, "default": [] },
                    "extra_ng_domains": { "type": "array", "items": { "type": "string" }, "default": [] }
                }
            },
            "categories": {
                "type": "object",
                "description": "Per-user category aliases / merges (display only)",
                "properties": {
                    "aliases": {
                        "type": "object",
                        "description": "{ from_category: to_category }",
                        "default": {}
                    }
                }
            }
        }
    }'::jsonb,
    '[
        {
            "code": "memoria.search",
            "name": "Search bookmarks",
            "description": "Substring search across saved title / url / summary / memo for the calling user.",
            "params": { "query": "string", "limit": "integer (optional, default 20)" }
        },
        {
            "code": "memoria.save_url",
            "name": "Save a URL",
            "description": "Server-side fetch + save + summary queue. Returns { status: queued|duplicate|blocked, id?, reason? }.",
            "params": { "url": "string" }
        },
        {
            "code": "memoria.list_categories",
            "name": "List categories",
            "description": "All categories with bookmark counts."
        },
        {
            "code": "memoria.recent_bookmarks",
            "name": "Recent bookmarks",
            "description": "Most recently saved bookmarks for the calling user.",
            "params": { "limit": "integer (optional, default 10)" }
        },
        {
            "code": "memoria.get_bookmark",
            "name": "Get bookmark",
            "description": "Full metadata for one bookmark id (must belong to the calling user).",
            "params": { "id": "integer" }
        },
        {
            "code": "memoria.dig",
            "name": "Dig (deep research)",
            "description": "Run a Web-search-backed research session for the given query. Async — completion is announced via memoria.dig.completed.",
            "params": { "query": "string" }
        },
        {
            "code": "memoria.unsaved_visits",
            "name": "Unsaved visits (local-only)",
            "description": "Recent visited URLs that are not yet bookmarked. Disabled in online mode.",
            "params": { "days": "integer (optional, default 7)" }
        },
        {
            "code": "ping",
            "name": "Ping",
            "description": "Connectivity check. Echoes payload."
        }
    ]'::jsonb,
    'https://github.com/LUDIARS/Memoria'
)
ON CONFLICT (code) DO NOTHING;
