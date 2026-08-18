-- EducationLab の launch credential 発行許可 (excubitor → EducationLab) を再宣言する。
--
-- migration 028 で INSERT した (EducationLab, excubitor) の grant が実 DB から失われており、
-- GLAB (catalog target_project=EducationLab) の起動時に
-- "Project \"excubitor\" may not issue credentials for \"EducationLab\"" (403) で落ちる。
-- 冪等に再投入し、宣言された状態へ戻す。glab key 向けの暫定 grant (042 期) には触れない。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
VALUES ('EducationLab', 'excubitor', TRUE)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
