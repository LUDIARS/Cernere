-- 操作ログテーブル
-- WS セッション中の全操作を記録する

CREATE TABLE IF NOT EXISTS operation_logs (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id),
    session_id  TEXT NOT NULL,
    method      TEXT NOT NULL,              -- "Organization.Create", "Member.Add" etc.
    params      JSONB NOT NULL DEFAULT '{}', -- 入力パラメータ
    status      TEXT NOT NULL,              -- "ok" / "error"
    error       TEXT,                       -- エラー時のメッセージ
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_user ON operation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_session ON operation_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_method ON operation_logs(method);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at);
