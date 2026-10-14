-- 企業認証の対応付けの提案 (Concordia spec/plan/2026-10-15-cf-cernere-sso.md Cr-2)。
--
-- 対応付けの無い Cloudflare subject でログインがあり、署名付き Access JWT の cr_user_id が
-- その接続の組織メンバーだったときに記録する。管理者が確定するまでセッションは出さない。
-- subject は平文で持たず、既存の enterprise_identities と同じ digest だけを持つ。
CREATE TABLE IF NOT EXISTS enterprise_identity_suggestions (
    project_key     TEXT NOT NULL REFERENCES enterprise_connections(project_key) ON DELETE CASCADE,
    subject_hash    TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_key, subject_hash)
);
