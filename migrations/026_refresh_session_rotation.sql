-- refresh token ローテーション追跡列。
-- 一度ローテーションした refresh token 行は削除せず rotated_at を刻んで残し、
-- その token が再提示された場合を「盗用 (reuse)」として検出し、
-- 当該ユーザの全 refresh session を失効させる (family revoke) ために使う。
-- 行は既存の expires_at を過ぎれば掃除対象 (別ジョブ or 手運用) となる。
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

-- reuse 判定の lookup は refresh_token (unique) 側で引くため追加インデックス不要。
-- family revoke (user_id 一括 delete) 用の user_id index は既存。
