/**
 * WebSocket `glab_membership` (spec/feature/glab-membership-github.md §6)。
 * GLab 組織の leader 以上かシステム管理者だけが使える。本人は自分の区分を変えられない。
 * 依存は差し替えられるようにし、権限と遷移の判定をテストで固定する。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import { AppError } from "../error.js";
import { canManageOrg } from "../org/role-policy.js";
import type { GlabConfig } from "./glab-config.js";
import type { GithubOrgClient } from "./github-org-client.js";
import { syncErrorText, syncMemberToGithub, type SyncOutcome } from "./github-sync.js";
import { transition, type GlabAction, type GlabMembershipRecord } from "./membership-policy.js";
import type { GlabMemberRow } from "./membership-store.js";
import { reconcile, type RecordedMember } from "./reconcile.js";

export interface GlabCommandDeps {
  config: GlabConfig | null;
  client: GithubOrgClient | null;
  /** 組織での立場。システム管理者は常に "system_admin"、それ以外は member のロール、非メンバーは null */
  actorRole(userId: string, organizationId: string): Promise<string | null>;
  list(organizationId: string): Promise<GlabMemberRow[]>;
  save(organizationId: string, userId: string, next: GlabMembershipRecord, actorUserId: string, now: Date): Promise<void>;
  recordSync(organizationId: string, userId: string, error: string | null, now: Date): Promise<void>;
  now(): Date;
}

function requireUserId(p: Record<string, unknown> | undefined): string {
  const v = p?.userId;
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw AppError.badRequest("userId is required");
  return v;
}

function view(row: GlabMemberRow) {
  return {
    userId: row.userId,
    displayName: row.displayName,
    orgRole: row.orgRole,
    githubLinked: row.githubId !== null,
    status: row.membership?.status ?? null,
    joinedAt: row.membership?.joinedAt.toISOString() ?? null,
    alumniAt: row.membership?.alumniAt?.toISOString() ?? null,
    githubSyncedAt: row.membership?.githubSyncedAt?.toISOString() ?? null,
    githubSyncError: row.membership?.githubSyncError ?? null,
  };
}

export async function glabMembershipCommand(deps: GlabCommandDeps, actorUserId: string, action: string,
  p?: Record<string, unknown>): Promise<unknown> {
  const config = deps.config;
  if (!config) throw AppError.withCode(503, "glab_disabled", "GLab membership is not configured");
  const orgId = config.organizationId;
  const role = await deps.actorRole(actorUserId, orgId);
  if (!role || !canManageOrg(role)) throw AppError.forbidden("GLab leader or above is required");

  const sync = async (row: GlabMemberRow): Promise<SyncOutcome> => {
    if (!row.membership) return { kind: "skipped", reason: "github_unlinked" };
    const outcome = await syncMemberToGithub(row.membership.status, row.githubId, config.github, deps.client);
    await deps.recordSync(orgId, row.userId, syncErrorText(outcome), deps.now());
    return outcome;
  };

  switch (action) {
    case "list":
      return { organizationId: orgId, githubConfigured: config.github !== null, members: (await deps.list(orgId)).map(view) };
    case "join":
    case "graduate":
    case "restore_student": {
      const targetUserId = requireUserId(p);
      if (targetUserId === actorUserId) throw AppError.forbidden("You cannot change your own GLab status");
      const row = (await deps.list(orgId)).find((m) => m.userId === targetUserId);
      if (!row) throw AppError.notFound("Not a member of the GLab organization");
      const result = transition(row.membership, action as GlabAction, deps.now());
      if (!result.ok) throw AppError.withCode(409, "glab_transition_invalid", result.reason);
      await deps.save(orgId, targetUserId, result.next, actorUserId, deps.now());
      const outcome = await sync({ ...row, membership: { ...result.next, githubSyncedAt: null, githubSyncError: null } });
      return { status: result.next.status, github: outcome };
    }
    case "sync": {
      const targetUserId = requireUserId(p);
      const row = (await deps.list(orgId)).find((m) => m.userId === targetUserId);
      if (!row?.membership) throw AppError.notFound("No GLab membership record");
      return { github: await sync(row) };
    }
    case "reconcile": {
      if (!config.github || !deps.client) throw AppError.withCode(503, "github_not_configured", "GitHub is not configured");
      const rows = (await deps.list(orgId)).filter((r) => r.membership);
      const records: RecordedMember[] = [];
      for (const r of rows) {
        const login = r.githubId === null ? null : await deps.client.loginForId(r.githubId);
        records.push({ userId: r.userId, displayName: r.displayName, status: r.membership!.status, githubLogin: login });
      }
      const [students, alumni] = await Promise.all([
        deps.client.teamMembers(config.github.studentTeam),
        deps.client.teamMembers(config.github.alumniTeam),
      ]);
      return { discrepancies: reconcile(records, students, alumni) };
    }
    case "apply_org_settings": {
      if (role !== "system_admin") throw AppError.forbidden("System admin required");
      if (!config.github || !deps.client) throw AppError.withCode(503, "github_not_configured", "GitHub is not configured");
      await deps.client.applyOrgSettings();
      return { ok: true };
    }
    default:
      throw AppError.badRequest(`Unknown glab_membership action: ${action}`);
  }
}
