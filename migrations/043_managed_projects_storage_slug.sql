-- project key と storage 識別子の分離 (Corpus spec/plan/auth-plane-consolidation.md §4.4)。
--
-- これまで project key は「人が読む識別子 / SQL 識別子 (project_data_<key>) / 認可の判別子」の
-- 3 役を兼ねていた。認可は identity_claims / user_data.columns の宣言駆動に置換済み。
-- ここで SQL 識別子の兼務を切り、managed_projects.storage_slug が project_data_<slug> を決める。
--
-- storage_slug は発行時に固定し、二度と変えない。値はサーバー側 (storage-slug.ts) でも
-- 常に検証してから table identifier に解決する。

ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS storage_slug TEXT;

-- backfill:
--   - 既に安全な key はそのまま (既存の project_data_<key> テーブルが動き続ける)
--   - 制約に落ちる key は 小文字化 + 非許可文字を _ に置換 + 先頭が英字でなければ p_ を前置
--   - 同じ slug に畳まれる key が複数あれば 2 件目以降に _2, _3 ... を付ける
--   - project_data_ (13 文字) + slug が PostgreSQL の識別子上限 63 に収まるよう 50 文字で切る
--
-- 全候補を同時に rank すると、例えば a-b / a_b / a_b_2 が a_b_2 で再衝突する。
-- 1 行ずつ確定済み slug を見ながら採番し、suffix 分を先に切り詰めて一意性を保証する。
DO $$
DECLARE
  project_row RECORD;
  candidate TEXT;
  suffix TEXT;
  n INTEGER;
BEGIN
  FOR project_row IN
    WITH normalized AS (
      SELECT
        key,
        CASE
          WHEN key ~ '^[a-z][a-z0-9_]{1,49}$' THEN key
          ELSE regexp_replace(
            lower(regexp_replace(key, '[^A-Za-z0-9_]', '_', 'g')),
            '^([^a-z])', 'p_\1'
          )
        END AS raw_base
      FROM managed_projects
      WHERE storage_slug IS NULL
    ), derived AS (
      SELECT
        key,
        CASE
          WHEN length(left(raw_base, 50)) >= 2 THEN left(raw_base, 50)
          ELSE rpad(left(raw_base, 50), 2, '_')
        END AS base
      FROM normalized
    )
    SELECT key, base
    FROM derived
    -- 既存 table 名を保てる canonical key を先に確保する。
    ORDER BY (key = base) DESC, key
  LOOP
    candidate := project_row.base;
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM managed_projects WHERE storage_slug = candidate
    ) LOOP
      suffix := '_' || n;
      candidate := left(project_row.base, 50 - length(suffix)) || suffix;
      n := n + 1;
    END LOOP;

    UPDATE managed_projects
    SET storage_slug = candidate
    WHERE key = project_row.key AND storage_slug IS NULL;
  END LOOP;
END $$;

ALTER TABLE managed_projects ALTER COLUMN storage_slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_projects_storage_slug ON managed_projects (storage_slug);

-- migrate.ts は unique_violation を冪等ケースとして継続する。重複によって上の CREATE が
-- skip されても migration を完了扱いにしないよう、index の実在と有効性を明示検証する。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
    WHERE index_relation.relname = 'idx_managed_projects_storage_slug'
      AND i.indrelid = 'managed_projects'::regclass
      AND i.indisunique
      AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'managed_projects.storage_slug unique index is missing or invalid';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'managed_projects_storage_slug_format'
      AND conrelid = 'managed_projects'::regclass
  ) THEN
    ALTER TABLE managed_projects
      ADD CONSTRAINT managed_projects_storage_slug_format
      CHECK (storage_slug ~ '^[a-z][a-z0-9_]{1,49}$');
  END IF;
END $$;
