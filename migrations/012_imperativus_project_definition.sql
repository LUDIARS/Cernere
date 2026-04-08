-- Imperativus プロジェクト定義
-- Voice Command Router のプロジェクトスキーマを登録する。
-- 冪等: ON CONFLICT で既存行はスキップする。

INSERT INTO project_definitions (id, code, name, data_schema, commands, plugin_repository)
VALUES (
    'a1b2c3d4-5678-4def-9abc-def012345678',
    'imperativus',
    'Imperativus — Voice Command Router',
    '{
        "type": "object",
        "description": "Per-user Imperativus configuration stored in Cernere",
        "properties": {
            "stt": {
                "type": "object",
                "description": "Speech-to-text preferences",
                "properties": {
                    "language":  { "type": "string", "default": "ja" },
                    "backend":   { "type": "string", "enum": ["faster-whisper", "vosk", "whisper-cpp", "speech-recognition"], "default": "faster-whisper" },
                    "model":     { "type": "string", "default": "base" },
                    "device":    { "type": "string", "enum": ["auto", "cpu", "cuda"], "default": "auto" }
                }
            },
            "claude": {
                "type": "object",
                "description": "Claude Code backend settings",
                "properties": {
                    "working_directory": { "type": "string", "default": "." },
                    "timeout":           { "type": "integer", "minimum": 1, "default": 120 }
                }
            },
            "plugins": {
                "type": "object",
                "description": "Plugin enable/disable state",
                "properties": {
                    "enabled":  { "type": "array", "items": { "type": "string" }, "default": [] },
                    "disabled": { "type": "array", "items": { "type": "string" }, "default": [] }
                }
            },
            "templates": {
                "type": "object",
                "description": "Voice template overrides",
                "properties": {
                    "custom": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name":     { "type": "string" },
                                "triggers": { "type": "array", "items": { "type": "string" } },
                                "prompt":   { "type": "string" }
                            },
                            "required": ["name", "triggers", "prompt"]
                        },
                        "default": []
                    }
                }
            },
            "ui": {
                "type": "object",
                "description": "Client UI preferences",
                "properties": {
                    "theme":           { "type": "string", "enum": ["light", "dark", "system"], "default": "system" },
                    "show_transcript": { "type": "boolean", "default": true },
                    "auto_listen":     { "type": "boolean", "default": false }
                }
            }
        }
    }'::jsonb,
    '[
        {
            "code": "voice.start",
            "name": "Start Voice Session",
            "description": "Start a new voice capture session with STT"
        },
        {
            "code": "voice.stop",
            "name": "Stop Voice Session",
            "description": "Stop the active voice session"
        },
        {
            "code": "template.list",
            "name": "List Templates",
            "description": "List available voice command templates"
        },
        {
            "code": "template.execute",
            "name": "Execute Template",
            "description": "Execute a voice template by name",
            "params": { "name": "string", "input": "string" }
        },
        {
            "code": "plugin.list",
            "name": "List Plugins",
            "description": "List loaded plugins and their intents"
        },
        {
            "code": "plugin.toggle",
            "name": "Toggle Plugin",
            "description": "Enable or disable a plugin",
            "params": { "name": "string", "enabled": "boolean" }
        },
        {
            "code": "settings.get",
            "name": "Get Settings",
            "description": "Retrieve user settings"
        },
        {
            "code": "settings.update",
            "name": "Update Settings",
            "description": "Update user settings",
            "params": { "key": "string", "value": "any" }
        }
    ]'::jsonb,
    'https://github.com/LUDIARS/Imperativus'
)
ON CONFLICT (code) DO NOTHING;
