-- GLab の入会・OB 切り替えと GitHub チーム管理 (spec/feature/glab-membership-github.md §4)。
--
-- glab_memberships: GLab 組織のメンバーごとの在籍区分 (student / alumni) と GitHub への反映状況。
-- 区分を変えるのは組織の leader 以上かシステム管理者だけ (本人は変えられない)。
CREATE TABLE IF NOT EXISTS glab_memberships (
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  alumni_at TIMESTAMPTZ,
  github_synced_at TIMESTAMPTZ,
  github_sync_error TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT chk_glab_memberships_status CHECK (status IN ('student', 'alumni'))
);
CREATE INDEX IF NOT EXISTS idx_glab_memberships_user ON glab_memberships(user_id);

-- glab_github_repos: GitHub の repository.created webhook で受けたリポジトリと、自動で権限を付けたか。
CREATE TABLE IF NOT EXISTS glab_github_repos (
  repo_full_name TEXT PRIMARY KEY,
  creator_github_id BIGINT,
  creator_user_id UUID,
  creator_status TEXT,
  granted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
