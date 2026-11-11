/**
 * GitHub のチームと Cernere の在籍記録の照合 (純粋関数) (spec/feature/glab-membership-github.md §3)。
 * GitHub の login は大文字小文字を区別しないので小文字で比べる。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import type { GlabStatus } from "./membership-policy.js";

export type DiscrepancyKind =
  | "alumni_in_student_team"
  | "student_missing"
  | "alumni_missing"
  | "student_in_alumni_team"
  | "unknown_member"
  | "unlinked";

export interface Discrepancy {
  kind: DiscrepancyKind;
  userId: string | null;
  displayName: string | null;
  githubLogin: string | null;
}

export interface RecordedMember {
  userId: string;
  displayName: string;
  status: GlabStatus;
  /** GitHub 連携済みなら現在の login、未連携なら null */
  githubLogin: string | null;
}

export function reconcile(records: RecordedMember[], studentTeam: string[], alumniTeam: string[]): Discrepancy[] {
  const students = new Set(studentTeam.map((l) => l.toLowerCase()));
  const alumni = new Set(alumniTeam.map((l) => l.toLowerCase()));
  const known = new Set<string>();
  const out: Discrepancy[] = [];
  const push = (kind: DiscrepancyKind, r: RecordedMember | null, login: string | null) =>
    out.push({ kind, userId: r?.userId ?? null, displayName: r?.displayName ?? null, githubLogin: login });

  for (const r of records) {
    if (!r.githubLogin) { push("unlinked", r, null); continue; }
    const login = r.githubLogin.toLowerCase();
    known.add(login);
    if (r.status === "student") {
      if (!students.has(login)) push("student_missing", r, r.githubLogin);
      if (alumni.has(login)) push("student_in_alumni_team", r, r.githubLogin);
    } else {
      if (students.has(login)) push("alumni_in_student_team", r, r.githubLogin);
      if (!alumni.has(login)) push("alumni_missing", r, r.githubLogin);
    }
  }
  for (const login of [...new Set([...studentTeam, ...alumniTeam])]) {
    if (!known.has(login.toLowerCase())) push("unknown_member", null, login);
  }
  return out;
}
