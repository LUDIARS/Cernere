/**
 * GLab の GitHub webhook (spec/feature/glab-membership-github.md §2)。
 * `X-Hub-Signature-256` (HMAC-SHA256) を検証し、`repository.created` で作った人の区分を Cernere の記録から引いて、
 * 在校生が作ったものにだけ在校生チーム=push・OB チーム=pull を付ける。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import crypto from "node:crypto";
import type { GlabGithubConfig } from "./glab-config.js";
import type { GithubOrgClient } from "./github-org-client.js";
import { repoGrants, type GlabStatus } from "./membership-policy.js";

export function verifyGithubSignature(secret: string, rawBody: string, header: string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export interface RepoCreatedDeps {
  github: GlabGithubConfig;
  client: GithubOrgClient;
  creatorStatus(githubId: number): Promise<{ userId: string; status: GlabStatus } | null>;
  record(row: { repoFullName: string; creatorGithubId: number | null; creatorUserId: string | null; creatorStatus: GlabStatus | null; grantedAt: Date | null }): Promise<void>;
}

export type WebhookResult = { handled: false; reason: string } | { handled: true; granted: number };

interface RepositoryEvent {
  action?: string;
  repository?: { full_name?: string; owner?: { login?: string } };
  sender?: { id?: number };
}

export async function handleGithubWebhook(event: string, payload: unknown, deps: RepoCreatedDeps, now = new Date()): Promise<WebhookResult> {
  if (event === "ping") return { handled: false, reason: "ping" };
  if (event !== "repository") return { handled: false, reason: "ignored_event" };
  const body = (payload ?? {}) as RepositoryEvent;
  if (body.action !== "created") return { handled: false, reason: "ignored_action" };
  const fullName = body.repository?.full_name;
  // 他の組織のリポジトリには触らない。
  if (!fullName || body.repository?.owner?.login?.toLowerCase() !== deps.github.org.toLowerCase()) {
    return { handled: false, reason: "other_owner" };
  }
  const senderId = typeof body.sender?.id === "number" ? body.sender.id : null;
  const creator = senderId === null ? null : await deps.creatorStatus(senderId);
  const grants = repoGrants(creator?.status ?? null);
  for (const g of grants) {
    await deps.client.grantTeamRepo(g.team === "student" ? deps.github.studentTeam : deps.github.alumniTeam, fullName, g.permission);
  }
  await deps.record({
    repoFullName: fullName, creatorGithubId: senderId, creatorUserId: creator?.userId ?? null,
    creatorStatus: creator?.status ?? null, grantedAt: grants.length > 0 ? now : null,
  });
  return { handled: true, granted: grants.length };
}
