/**
 * 在籍区分を GitHub のチームに反映する (spec/feature/glab-membership-github.md §1)。
 * 未連携・未設定は反映せず理由を返す。結果は呼出し側が記録に残す。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import type { GlabGithubConfig } from "./glab-config.js";
import type { GithubOrgClient } from "./github-org-client.js";
import { teamPlan, type GlabStatus } from "./membership-policy.js";

export type SyncOutcome =
  | { kind: "synced"; login: string }
  | { kind: "skipped"; reason: "github_not_configured" | "github_unlinked" | "github_user_missing" }
  | { kind: "failed"; error: string };

export async function syncMemberToGithub(status: GlabStatus, githubId: number | null,
  github: GlabGithubConfig | null, client: GithubOrgClient | null): Promise<SyncOutcome> {
  if (!github || !client) return { kind: "skipped", reason: "github_not_configured" };
  if (githubId === null) return { kind: "skipped", reason: "github_unlinked" };
  try {
    const login = await client.loginForId(githubId);
    if (!login) return { kind: "skipped", reason: "github_user_missing" };
    const plan = teamPlan(status);
    const slug = (t: "student" | "alumni") => (t === "student" ? github.studentTeam : github.alumniTeam);
    // 先に外す: OB 化したときに書き込み権限が残る時間を作らない。
    await client.removeFromTeam(slug(plan.leave), login);
    await client.addToTeam(slug(plan.join), login);
    return { kind: "synced", login };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** 記録に残す文言 (成功は null)。 */
export function syncErrorText(outcome: SyncOutcome): string | null {
  if (outcome.kind === "synced") return null;
  if (outcome.kind === "failed") return outcome.error;
  return outcome.reason;
}
