-- 組織（Organization）とプロジェクト定義

-- 組織テーブル
CREATE TABLE IF NOT EXISTS organizations (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 組織メンバーテーブル (ユーザーは複数の組織に所属可能)
CREATE TABLE IF NOT EXISTS organization_members (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',  -- owner / admin / member
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- プロジェクト定義テーブル (Ars, Schedula などのプロジェクトタイプ)
CREATE TABLE IF NOT EXISTS project_definitions (
    id                  UUID PRIMARY KEY,
    code                TEXT NOT NULL UNIQUE,           -- プロジェクトコード (例: "ars", "schedula")
    name                TEXT NOT NULL,                  -- プロジェクト名
    data_schema         JSONB NOT NULL DEFAULT '{}',    -- 保存するデータスキーマ
    commands            JSONB NOT NULL DEFAULT '[]',    -- 適用可能なコマンドリスト
    plugin_repository   TEXT NOT NULL DEFAULT '',       -- プラグインリポジトリ URL
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 組織が使用するプロジェクト定義 (各組織はどのプロジェクトを使用するかを選択)
CREATE TABLE IF NOT EXISTS organization_projects (
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_definition_id UUID NOT NULL REFERENCES project_definitions(id) ON DELETE CASCADE,
    enabled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, project_definition_id)
);
