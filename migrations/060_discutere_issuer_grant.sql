-- Discutere の launch credential 発行許可 (excubitor → discutere) を宣言する。
--
-- Discutere は Excubitor の catalog で cernere_launch_credentials.target_project=discutere を持ち、
-- 起動ごとに credential を発行させる。managed_projects の discutere は 058 で登録済みだが、
-- project_credential_issuers に (discutere, excubitor) の行が無いため fail-closed の issuer 検査に落ち、
-- Excubitor からの起動が "Cernere launch credential issuance failed for discutere: HTTP 403" で止まっていた
-- (2026-10-05)。056 (Bibliotheca) と同じ形で冪等に投入する。
INSERT INTO project_credential_issuers (target_project_key, issuer_project_key, is_active)
VALUES ('discutere', 'excubitor', TRUE)
ON CONFLICT (target_project_key, issuer_project_key) DO UPDATE SET
    is_active = TRUE,
    updated_at = now();
