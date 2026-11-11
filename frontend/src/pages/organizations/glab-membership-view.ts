/**
 * GLab 在籍パネルの表示規則 (純粋関数)。spec/feature/glab-membership-github.md。
 */

export interface GlabMemberView {
  userId: string;
  displayName: string;
  orgRole: string;
  githubLinked: boolean;
  status: "student" | "alumni" | null;
  joinedAt: string | null;
  alumniAt: string | null;
  githubSyncedAt: string | null;
  githubSyncError: string | null;
}

export type GlabRowAction = "join" | "graduate" | "restore_student" | "sync";

export function statusLabel(status: GlabMemberView["status"]): string {
  if (status === "student") return "在校生";
  if (status === "alumni") return "OB";
  return "未記録";
}

/** 行に出す操作。自分の区分は変えられない。 */
export function rowActions(member: GlabMemberView, selfUserId: string | undefined): Array<{ action: GlabRowAction; label: string }> {
  if (member.userId === selfUserId) return [];
  if (member.status === null) return [{ action: "join", label: "入会を記録" }];
  const base = member.status === "student"
    ? [{ action: "graduate" as const, label: "OB にする" }]
    : [{ action: "restore_student" as const, label: "在校生に戻す (訂正)" }];
  return [...base, { action: "sync", label: "GitHub に反映" }];
}

const SYNC_REASON: Record<string, string> = {
  github_not_configured: "GitHub 連携が未設定",
  github_unlinked: "GitHub 未連携",
  github_user_missing: "GitHub アカウントが見つからない",
};

export function githubStateLabel(member: GlabMemberView): string {
  if (!member.githubLinked) return "GitHub 未連携";
  if (member.githubSyncError) return `反映できていません: ${SYNC_REASON[member.githubSyncError] ?? member.githubSyncError}`;
  if (member.githubSyncedAt) return `反映済み (${new Date(member.githubSyncedAt).toLocaleString()})`;
  return member.status ? "未反映" : "";
}

const DISCREPANCY_LABEL: Record<string, string> = {
  alumni_in_student_team: "OB なのに在校生チームにいる",
  student_missing: "在校生なのに在校生チームにいない",
  alumni_missing: "OB なのに OB チームにいない",
  student_in_alumni_team: "在校生なのに OB チームにいる",
  unknown_member: "チームにいるが Cernere の記録に無い",
  unlinked: "記録はあるが GitHub 未連携",
};

export function discrepancyLabel(kind: string): string {
  return DISCREPANCY_LABEL[kind] ?? kind;
}
