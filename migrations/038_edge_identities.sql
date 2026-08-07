-- エッジ認証 (Cloudflare Access バイパス) — spec/feature/edge-assertion-login.md
--
-- 上流エッジ (CF Access) で本人確認済みのアサーションを Cernere が検証し、
-- 再ログイン無しで Cernere セッションを発行するための表。
--
-- アカウントの正本キーは email。 idp_subject は「email 変更に追従するための
-- 副次インデックス」であり任意 (spec §5.1)。

CREATE TABLE IF NOT EXISTS edge_identities (
    id             UUID PRIMARY KEY,
    provider       TEXT NOT NULL,              -- 'cf_access'
    team_domain    TEXT NOT NULL,              -- '<team>.cloudflareaccess.com'
    email          TEXT NOT NULL,              -- 正本キー (小文字化 + trim 済み)
    idp_subject    TEXT,                       -- 上流 IdP の subject (custom OIDC claim 由来、任意)
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cf_sub         TEXT,                       -- CF の sub。 監査用 (キーにしない)
    cf_user_uuid   TEXT,                       -- get-identity の user_uuid。 監査用
    idp_type       TEXT,                       -- 'google' / 'azureAD' / 'onetimepin' ...
    idp_name       TEXT,                       -- get-identity の name (表示名変更の候補)
    groups         JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_seen_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_identities_email
    ON edge_identities (provider, team_domain, email);
CREATE INDEX IF NOT EXISTS idx_edge_identities_user ON edge_identities (user_id);
CREATE INDEX IF NOT EXISTS idx_edge_identities_last_seen ON edge_identities (last_seen_at);

-- subject 先引き (spec §5.2 の解決順) 用。 NULL 許容なので部分 index にする。
CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_identities_subject
    ON edge_identities (provider, team_domain, idp_subject)
    WHERE idp_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS edge_idp_bindings (
    project_key           TEXT PRIMARY KEY,
    provider              TEXT NOT NULL DEFAULT 'cf_access',
    team_domain           TEXT NOT NULL,
    aud_tags              JSONB NOT NULL,      -- ["<application aud tag>", ...]
    subject_claim         TEXT,                -- custom claim 名 (例 'sub' / 'oid')。 任意
    allowed_email_domains JSONB NOT NULL,      -- ["example.co.jp"] — 空配列は登録時に拒否
    provisioning          TEXT NOT NULL,       -- 'auto' | 'link_only' | 'invite_only'
    default_role          TEXT NOT NULL DEFAULT 'general',
    admin_groups          JSONB NOT NULL DEFAULT '[]'::jsonb, -- reserved; non-empty rejected until role provenance exists
    fetch_identity        BOOLEAN NOT NULL DEFAULT true,
    require_device_check  BOOLEAN NOT NULL DEFAULT false,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 表示名の出所。 'user' はユーザ自身が設定した = 自動上書きしない (spec §5.2.2)。
-- 既存行の既定を 'user' にしてあるのは、 migration 直後の初回ログインで
-- 既存ユーザの表示名を書き換えないため。
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name_source TEXT NOT NULL DEFAULT 'user';

-- 退職者削除 (spec §5.4) に FK 変更は不要。
--
-- 既存の deleteUserAccount() (server/src/project/service.ts) が CASCADE を持たない
-- 参照を先処理済みなので、 purge_user はそれを再利用する:
--   - operation_logs は行ごと削除する (params に PII / token が残るため、
--     「個人データを消す」操作で監査行だけ残すのは筋が通らない。 FLOW-L1 対応)
--   - project_definition_history.applied_by は NULL 化 (履歴自体は保持)
--   - organizations.created_by は FK のまま = 組織を持つユーザの削除は fail-closed
--
-- purge_user では、 組織を持つ場合だけ owns_organizations で事前に拒否する。
