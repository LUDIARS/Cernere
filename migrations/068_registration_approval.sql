-- ユーザー登録の許可制 (spec/plan/2026-10-14-registration-approval-design-astra.md 案 A)。
--
-- 新規ユーザーは pending (許可待ち) で、Cernere 内の本人用操作だけができる。admin が許可すると
-- active になり、他人の公開データとサービスへのログインへ進める。locked は全経路で拒否する。
-- Cr は本運用前で DB をリセットするため、既存ユーザーの backfill はしない。
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE users ADD CONSTRAINT chk_users_access_status CHECK (access_status IN ('pending', 'active', 'locked'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_changed_at TIMESTAMPTZ;

-- 利用申請。ユーザーごとに未決は 1 件。
CREATE TABLE IF NOT EXISTS registration_requests (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state           TEXT NOT NULL CHECK (state IN ('open', 'withdrawn', 'approved', 'rejected', 'expired')),
    purpose         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_registration_requests_open
  ON registration_requests (user_id)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS idx_registration_requests_open_created
  ON registration_requests (created_at)
  WHERE state = 'open';

-- 許可・拒否・ロック・解除の監査。状態の変更と同じトランザクションで書く。
CREATE TABLE IF NOT EXISTS access_decisions (
    id                  UUID PRIMARY KEY,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    target_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expected_revision   INTEGER NOT NULL,
    before_status       TEXT NOT NULL,
    after_status        TEXT NOT NULL,
    reason_code         TEXT NOT NULL,
    request_id          UUID REFERENCES registration_requests(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_decisions_target
  ON access_decisions (target_user_id, created_at DESC);
