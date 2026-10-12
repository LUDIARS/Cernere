-- Bibliotheca の launch credential 発行許可 (excubitor → bibliotheca) を宣言する。
--
-- Bibliotheca は Vault-only 移行 (Bibliotheca #2402) で Excubitor の catalog に登録され、
-- cernere_launch_credentials.target_project=bibliotheca で起動ごとに credential を発行させる。
-- managed_projects の bibliotheca は既に存在するが、project_credential_issuers に
-- (bibliotheca, excubitor) の行が無いため fail-closed の issuer 検査に落ち、Excubitor からの起動が
-- "Cernere launch credential issuance failed for bibliotheca: HTTP 403" で止まっていた。
-- 046 (Aedilis) と同じ形で冪等に投入する。
--
-- bibliotheca の managed project は migration では作られず、本番 DB にだけ存在する。
-- 新しい DB (本社テスト用 cernere_test など) では外部キー違反で migration 全体が止まるため、
-- 046 と同じく対象 project がある DB でだけ投入する (2026-10-12)。適用済みの DB では再実行されない。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
SELECT 'bibliotheca', 'excubitor', TRUE
WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = 'bibliotheca')
  AND EXISTS (SELECT 1 FROM managed_projects WHERE key = 'excubitor')
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
