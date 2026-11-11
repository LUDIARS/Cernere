-- V.O.B の Discord 発行トークンによる登録 (spec/feature/vob-discord-registration.md §3)。
--
-- V.O.B Discord サーバーのスラッシュコマンドで発行する一回限りの登録トークン。
-- トークンは SHA-256 で保存し、平文は Discord の ephemeral 応答だけで返す。
-- 発行時にサーバー参加を確かめた Discord ID と参加日時に束縛し、
-- パスキー signup が同じトランザクションで consumed_at を記録して一度だけ使う。
-- 期限切れの行は 1 日で回収する (vob/vob-token-store.ts)。
CREATE TABLE IF NOT EXISTS vob_registration_tokens (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL,
  discord_username TEXT,
  guild_joined_at TIMESTAMPTZ,
  organization_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id UUID,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vob_registration_tokens_expires ON vob_registration_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_vob_registration_tokens_discord ON vob_registration_tokens(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_vob_registration_tokens_consumer ON vob_registration_tokens(consumed_by_user_id);

-- 登録の経路に discord_vob (V.O.B Discord 経由) を足す。
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_registration_origin;
ALTER TABLE users ADD CONSTRAINT chk_users_registration_origin
  CHECK (registration_origin IS NULL OR registration_origin IN ('venue', 'outside_venue', 'discord_vob'));
