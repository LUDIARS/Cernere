ALTER TABLE device_credentials
  ADD COLUMN IF NOT EXISTS proof_public_key text,
  ADD COLUMN IF NOT EXISTS proof_project text,
  ADD COLUMN IF NOT EXISTS proof_ip_tag text;
