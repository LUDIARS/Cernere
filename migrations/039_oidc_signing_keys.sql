CREATE TABLE IF NOT EXISTS oidc_signing_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid text NOT NULL UNIQUE,
  private_key_pem text NOT NULL,
  public_key_pem text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

-- 現行鍵は常に高々 1 本。
CREATE UNIQUE INDEX IF NOT EXISTS idx_oidc_signing_keys_current
  ON oidc_signing_keys ((is_current)) WHERE is_current;
