-- Volputas → Voluptas: managed project key の綴りを正す (2026-10-10 neco 指示「新綴りへ全面移行」)。
--
-- Voluptas 側は catalog / package 名を新綴りへ揃え済み (Voluptas 03fd8a2) で、
-- Excubitor の launch credential が target_project=voluptas を要求して HTTP 403 になっていた。
-- 旧綴りの別名は作らず、Cernere / Voluptas / Discutere を同時に新綴りへ切り替える。
--
-- 方針:
--   - managed_projects.key を 'volputas' → 'voluptas' に改名する。行 (client_id / secret /
--     schema_definition の scope 宣言) はそのまま保つので、Voluptas の既存 credential は有効。
--   - storage_slug は 'volputas' のまま変えない (043: 発行後は不変)。project_data_volputas と
--     volputas_survey_* テーブルはそのまま使い続ける (データ移動なし)。
--   - key を参照する FK はどれも ON UPDATE が NO ACTION なので、ON DELETE の動作を保ったまま
--     ON UPDATE CASCADE に付け直してから改名する。将来の改名にも同じ形が使える。
--   - FK の無い project_key 列 (project_oauth_tokens / edge_idp_bindings) は個別に書き換える。
--   - 発行済みの user_for_project token (projectKey=volputas) は失効扱いになり、再ログインが要る。
--
-- ランナーは文単位で流し 23505 等を握りつぶすため、全体を 1 つの DO ブロックにして原子的に適用する。
-- 既に 'voluptas' がある / 'volputas' が無い場合は何もしない (冪等)。
DO $$
DECLARE
  fk RECORD;
  delete_action TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM managed_projects WHERE key = 'voluptas') THEN
    RAISE NOTICE 'managed project voluptas already exists; skip rename';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM managed_projects WHERE key = 'volputas') THEN
    RAISE NOTICE 'managed project volputas not found; skip rename';
    RETURN;
  END IF;

  FOR fk IN
    SELECT c.conname,
           c.conrelid::regclass AS child_table,
           a.attname AS child_column,
           c.confdeltype
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'managed_projects'::regclass
       AND array_length(c.conkey, 1) = 1
       AND c.confupdtype <> 'c'
  LOOP
    delete_action := CASE fk.confdeltype
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
      WHEN 'r' THEN 'RESTRICT'
      ELSE 'NO ACTION'
    END;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.child_table, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES managed_projects(key) ON UPDATE CASCADE ON DELETE %s',
      fk.child_table, fk.conname, fk.child_column, delete_action
    );
  END LOOP;

  UPDATE managed_projects
     SET key = 'voluptas',
         name = 'Voluptas',
         schema_definition = CASE
           WHEN jsonb_typeof(schema_definition -> 'project') = 'object' THEN jsonb_set(
             jsonb_set(schema_definition, '{project,key}', '"voluptas"'::jsonb, true),
             '{project,name}', '"Voluptas"'::jsonb, true
           )
           ELSE schema_definition
         END,
         updated_at = now()
   WHERE key = 'volputas';

  IF to_regclass('project_oauth_tokens') IS NOT NULL THEN
    UPDATE project_oauth_tokens SET project_key = 'voluptas' WHERE project_key = 'volputas';
  END IF;
  IF to_regclass('edge_idp_bindings') IS NOT NULL THEN
    UPDATE edge_idp_bindings SET project_key = 'voluptas' WHERE project_key = 'volputas';
  END IF;
END
$$;
