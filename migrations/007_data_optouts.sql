-- データオプトアウト管理テーブル
-- ユーザーがサービスごと・カテゴリごとにデータのオプトアウトを記録する
CREATE TABLE IF NOT EXISTS user_data_optouts (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL,
    category_key    TEXT NOT NULL,
    opted_out_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, service_id, category_key)
);

CREATE INDEX IF NOT EXISTS idx_user_data_optouts_user ON user_data_optouts (user_id);
CREATE INDEX IF NOT EXISTS idx_user_data_optouts_user_service ON user_data_optouts (user_id, service_id);
