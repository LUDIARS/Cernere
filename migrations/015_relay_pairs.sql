-- ─────────────────────────────────────────────────────────────
-- Service adapter relay pairs (Phase 0b).
--
-- LUDIARS のバックエンドサービス同士が直接 WS を張るときの
-- 「誰↔誰」を Cernere が管理するテーブル. 双方 managed_projects に
-- 登録済みであることが前提 (FK).
--
-- 方向性: 既定は bidirectional = TRUE. unidirectional を使う場合は
--   from_project_key → to_project_key の 1 行だけ登録.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relay_pairs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_project_key TEXT NOT NULL REFERENCES managed_projects(key),
    to_project_key   TEXT NOT NULL REFERENCES managed_projects(key),
    bidirectional    BOOLEAN NOT NULL DEFAULT TRUE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_project_key, to_project_key)
);

CREATE INDEX IF NOT EXISTS idx_relay_pairs_from ON relay_pairs (from_project_key)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_relay_pairs_to ON relay_pairs (to_project_key)
    WHERE is_active = TRUE;
