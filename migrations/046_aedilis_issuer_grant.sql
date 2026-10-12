-- Aedilis の launch credential 発行許可 (excubitor → aedilis) を宣言する。
--
-- Aedilis の catalog は cernere_launch_credentials.target_project=aedilis で起動ごとに
-- credential を発行させるが、project_credential_issuers に (aedilis, excubitor) の行が
-- 無いため fail-closed の issuer 検査に落ち、Excubitor からの起動が
-- "Cernere launch credential issuance failed for aedilis: HTTP 403" で止まっていた。
-- managed_projects の aedilis は既に is_active=TRUE で存在する (credential_generation=0)。
-- 044 (EducationLab) と同じ形で冪等に投入する。
--
-- aedilis の managed project は migration では作られず、本番 DB にだけ存在する。
-- 新しい DB (本社テスト用 cernere_test など) では外部キー違反で migration 全体が止まるため、
-- 対象 project がある DB でだけ投入する (2026-10-12)。適用済みの DB では再実行されない。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
SELECT 'aedilis', 'excubitor', TRUE
WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = 'aedilis')
  AND EXISTS (SELECT 1 FROM managed_projects WHERE key = 'excubitor')
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
