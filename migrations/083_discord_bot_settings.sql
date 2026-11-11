-- Cernere の Discord Bot の設定と、サーバー参加から日が浅い人の許可制
-- (spec/feature/vob-discord-registration.md §4・§6)。
--
-- 設定は管理画面 (system admin) から書き、この 1 行だけを正本にする (環境変数からは読まない)。
-- Bot トークンは secret-box (AES-256-GCM, CERNERE_SECRET_KEY) で暗号化して保存し、画面には返さない。
CREATE TABLE IF NOT EXISTS discord_bot_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  application_id TEXT,
  public_key_hex TEXT,
  bot_token_enc TEXT,
  guild_id TEXT,
  organization_id UUID,
  admin_channel_id TEXT,
  approval_window_days INTEGER NOT NULL DEFAULT 7 CHECK (approval_window_days BETWEEN 0 AND 90),
  updated_by_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 発行時にサーバー参加から approval_window_days 日以内 (または参加日時が不明) だった人のトークン。
-- このトークンで登録した人は自動許可せず pending にし、管理者の許可で V.O.B 組織に入る。
ALTER TABLE vob_registration_tokens ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;
