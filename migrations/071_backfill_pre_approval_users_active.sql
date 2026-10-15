-- 許可制 (068) より前からいる利用者を active にする。
--
-- 068 は「Cr は本運用前で DB をリセットする」前提で backfill を持たなかったが、正本拠点 (AWS) は
-- リセットせずに 068 を適用する。そのままだと既存の利用者全員が pending になり、サービスへの
-- ログイン (service 向け authCode) が止まる (neco 判断 2026-10-15: 今の利用者を許可済みにして反映)。
--
-- 対象は 068 の適用時刻より前に作られた pending の利用者だけ。068 以降に登録した利用者は
-- 許可待ちのまま残す (既に 068 を適用済みの拠点で、正規の申請待ちを勝手に許可しない)。
-- 068 の適用記録が無い DB では何もしない。監査行 (access_decisions) を同じ文で書く。
-- runner は文ごとに実行するので、半端に適用されないよう 1 文 (CTE) にまとめる。
WITH cutoff AS (
    SELECT applied_at FROM _migrations WHERE version = '068_registration_approval'
),
targets AS (
    SELECT u.id, u.access_revision
      FROM users u, cutoff c
     WHERE u.access_status = 'pending'
       AND u.created_at < c.applied_at
       FOR UPDATE OF u
),
audit AS (
    INSERT INTO access_decisions
        (id, actor_user_id, target_user_id, expected_revision, before_status, after_status, reason_code, request_id)
    SELECT gen_random_uuid(), NULL, t.id, t.access_revision, 'pending', 'active', 'pre_approval_backfill', NULL
      FROM targets t
)
UPDATE users u
   SET access_status = 'active',
       access_revision = u.access_revision + 1,
       access_changed_at = now()
  FROM targets t
 WHERE u.id = t.id
