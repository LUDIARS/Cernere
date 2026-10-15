-- 2 台目の端末のログインとアカウント連携 (フェデレーション)
-- spec/plan/2026-10-15-account-federation-design.md §2。
--
-- account_federations は複数のアカウント (users 行) のまとまり。subject_id はサービスへ渡す固定の利用者番号で、
-- 連携を作ったときの最初のアカウントの user id をそのまま使う (既存のサービスデータを壊さない)。変えない。
-- primary_user_id は名前・プロフィール・許可状態の基準にするアカウント。revision は主の切替の競合検出に使う。
-- 1 アカウントは 1 連携まで (account_federation_members.user_id UNIQUE)。上限 10 アカウントはアプリ側で検査する。
CREATE TABLE IF NOT EXISTS account_federations (
    id               UUID PRIMARY KEY,
    subject_id       UUID NOT NULL UNIQUE,
    primary_user_id  UUID NOT NULL REFERENCES users(id),
    revision         INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_federation_members (
    federation_id    UUID NOT NULL REFERENCES account_federations(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    joined_via       TEXT NOT NULL CHECK (joined_via IN ('founder', 'qr_new_device', 'qr_existing_account')),
    joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (federation_id, user_id)
);

-- 監査 (追記のみ)。連携を閉じても残すため federation_id に FK は張らない。
CREATE TABLE IF NOT EXISTS account_federation_events (
    id              UUID PRIMARY KEY,
    federation_id   UUID NOT NULL,
    actor_user_id   UUID,
    target_user_id  UUID,
    action          TEXT NOT NULL CHECK (action IN ('create', 'join', 'leave', 'remove', 'set_primary')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_federation_events_federation ON account_federation_events (federation_id, created_at);
