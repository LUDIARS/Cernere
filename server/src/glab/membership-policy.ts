/**
 * GLab 在籍の規則 (純粋関数) (spec/feature/glab-membership-github.md §1・§2)。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */

export type GlabStatus = "student" | "alumni";
export type GlabAction = "join" | "graduate" | "restore_student";

export interface GlabMembershipRecord {
  status: GlabStatus;
  joinedAt: Date;
  alumniAt: Date | null;
}

export type TransitionResult =
  | { ok: true; next: GlabMembershipRecord }
  | { ok: false; reason: string };

/** 記録の遷移。入会は未記録の人だけ、OB 化は在校生だけ、在校生に戻すのは OB だけ。 */
export function transition(current: GlabMembershipRecord | null, action: GlabAction, now: Date): TransitionResult {
  switch (action) {
    case "join":
      if (current) return { ok: false, reason: "Already recorded as a GLab member" };
      return { ok: true, next: { status: "student", joinedAt: now, alumniAt: null } };
    case "graduate":
      if (!current) return { ok: false, reason: "Record the GLab join first" };
      if (current.status === "alumni") return { ok: false, reason: "Already an alumnus" };
      return { ok: true, next: { ...current, status: "alumni", alumniAt: now } };
    case "restore_student":
      if (!current || current.status !== "alumni") return { ok: false, reason: "Only an alumnus can be restored" };
      return { ok: true, next: { ...current, status: "student", alumniAt: null } };
  }
}

export interface TeamPlan { join: "student" | "alumni"; leave: "student" | "alumni" }

/** 区分ごとに入れるチームと外すチーム。 */
export function teamPlan(status: GlabStatus): TeamPlan {
  return status === "student" ? { join: "student", leave: "alumni" } : { join: "alumni", leave: "student" };
}

export type RepoPermission = "push" | "pull";

/**
 * 新しいリポジトリに自動で付ける権限。在校生が作ったものだけ (在校生チーム=読み書き、OB チーム=読むだけ)。
 * OB・不明な人が作ったものには付けない (作った本人が決める)。
 */
export function repoGrants(creatorStatus: GlabStatus | null): Array<{ team: "student" | "alumni"; permission: RepoPermission }> {
  if (creatorStatus !== "student") return [];
  return [{ team: "student", permission: "push" }, { team: "alumni", permission: "pull" }];
}

/** 組織の設定: メンバーは private だけ作れる。既定の権限は none (チームで付ける)。 */
export const GLAB_ORG_SETTINGS = {
  default_repository_permission: "none",
  members_can_create_repositories: true,
  members_can_create_private_repositories: true,
  members_can_create_public_repositories: false,
  members_can_create_internal_repositories: false,
} as const;
