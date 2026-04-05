-- プロジェクト定義の履歴テーブル
-- 登録時に使用した definition を保存し、参照可能にする
CREATE TABLE IF NOT EXISTS project_definition_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_key     TEXT NOT NULL REFERENCES managed_projects(key) ON DELETE CASCADE,
    definition      JSONB NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    applied_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_def_history_key ON project_definition_history (project_key);
CREATE INDEX IF NOT EXISTS idx_project_def_history_key_ver ON project_definition_history (project_key, version DESC);
