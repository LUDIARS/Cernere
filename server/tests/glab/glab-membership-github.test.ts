/** SPEC-GLAB-MEMBERSHIP-GITHUB: 遷移・チーム・リポジトリ権限・照合・反映・webhook・コマンドの権限。 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readGlabConfig, type GlabConfig } from "../../src/glab/glab-config.js";
import { createAppJwt } from "../../src/glab/github-app.js";
import type { GithubOrgClient } from "../../src/glab/github-org-client.js";
import { syncMemberToGithub } from "../../src/glab/github-sync.js";
import { handleGithubWebhook, verifyGithubSignature } from "../../src/glab/github-webhook.js";
import { glabMembershipCommand, type GlabCommandDeps } from "../../src/glab/glab-membership-command.js";
import { GLAB_ORG_SETTINGS, repoGrants, teamPlan, transition } from "../../src/glab/membership-policy.js";
import type { GlabMemberRow } from "../../src/glab/membership-store.js";
import { reconcile } from "../../src/glab/reconcile.js";
import { rowActions, statusLabel } from "../../../frontend/src/pages/organizations/glab-membership-view";

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ORG = "22222222-2222-4222-8222-222222222222";
const LEADER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const GITHUB = { org: "glab-org", appId: "1", installationId: "2", privateKeyPem: PEM, webhookSecret: "w".repeat(16), studentTeam: "students", alumniTeam: "alumni" };
const CONFIG: GlabConfig = { organizationId: ORG, github: GITHUB };

function fakeClient(over: Partial<GithubOrgClient> = {}) {
  const calls: string[] = [];
  const client: GithubOrgClient = {
    loginForId: async (id) => (id === 7 ? "Student-Login" : null),
    addToTeam: async (team, login) => { calls.push(`add:${team}:${login}`); },
    removeFromTeam: async (team, login) => { calls.push(`remove:${team}:${login}`); },
    teamMembers: async () => [],
    grantTeamRepo: async (team, repo, perm) => { calls.push(`grant:${team}:${repo}:${perm}`); },
    applyOrgSettings: async () => { calls.push("settings"); },
    ...over,
  };
  return { client, calls };
}

describe("membership transitions", () => {
  it("records join, graduation and the correction back to student", () => {
    const joined = transition(null, "join", NOW);
    expect(joined).toEqual({ ok: true, next: { status: "student", joinedAt: NOW, alumniAt: null } });
    const later = new Date(NOW.getTime() + 1000);
    const grad = transition(joined.ok ? joined.next : null, "graduate", later);
    expect(grad).toMatchObject({ ok: true, next: { status: "alumni", joinedAt: NOW, alumniAt: later } });
    expect(transition(grad.ok ? grad.next : null, "restore_student", later)).toMatchObject({ ok: true, next: { status: "student", alumniAt: null } });
  });

  it("refuses double joins, graduating the unrecorded and restoring a student", () => {
    const rec = { status: "student" as const, joinedAt: NOW, alumniAt: null };
    expect(transition(rec, "join", NOW).ok).toBe(false);
    expect(transition(null, "graduate", NOW).ok).toBe(false);
    expect(transition({ ...rec, status: "alumni", alumniAt: NOW }, "graduate", NOW).ok).toBe(false);
    expect(transition(rec, "restore_student", NOW).ok).toBe(false);
  });
});

describe("teams and repository grants", () => {
  it("moves students and alumni between the two teams", () => {
    expect(teamPlan("student")).toEqual({ join: "student", leave: "alumni" });
    expect(teamPlan("alumni")).toEqual({ join: "alumni", leave: "student" });
  });

  it("grants only on repositories created by students: students write, alumni read", () => {
    expect(repoGrants("student")).toEqual([{ team: "student", permission: "push" }, { team: "alumni", permission: "pull" }]);
    expect(repoGrants("alumni")).toEqual([]);
    expect(repoGrants(null)).toEqual([]);
  });

  it("keeps the organization private-only", () => {
    expect(GLAB_ORG_SETTINGS).toMatchObject({ members_can_create_private_repositories: true, members_can_create_public_repositories: false, default_repository_permission: "none" });
  });
});

describe("reconcile GitHub teams with Cernere records", () => {
  it("reports every kind of mismatch, case-insensitively", () => {
    const out = reconcile([
      { userId: "s1", displayName: "在校生OK", status: "student", githubLogin: "OkStudent" },
      { userId: "s2", displayName: "在校生なし", status: "student", githubLogin: "missing" },
      { userId: "a1", displayName: "OB残り", status: "alumni", githubLogin: "lingering" },
      { userId: "u1", displayName: "未連携", status: "student", githubLogin: null },
    ], ["okstudent", "lingering", "stranger"], []);
    const kinds = out.map((d) => `${d.kind}:${d.userId ?? d.githubLogin}`);
    expect(kinds).toEqual(expect.arrayContaining([
      "student_missing:s2", "alumni_in_student_team:a1", "alumni_missing:a1", "unlinked:u1", "unknown_member:stranger",
    ]));
    expect(kinds.some((k) => k.endsWith(":s1"))).toBe(false);
  });
});

describe("sync to GitHub", () => {
  it("removes from the old team before adding to the new one", async () => {
    const { client, calls } = fakeClient();
    await expect(syncMemberToGithub("alumni", 7, GITHUB, client)).resolves.toEqual({ kind: "synced", login: "Student-Login" });
    expect(calls).toEqual(["remove:students:Student-Login", "add:alumni:Student-Login"]);
  });

  it("holds back unlinked or unconfigured members and reports failures", async () => {
    const { client } = fakeClient();
    expect(await syncMemberToGithub("student", null, GITHUB, client)).toEqual({ kind: "skipped", reason: "github_unlinked" });
    expect(await syncMemberToGithub("student", 7, null, null)).toEqual({ kind: "skipped", reason: "github_not_configured" });
    expect(await syncMemberToGithub("student", 8, GITHUB, client)).toEqual({ kind: "skipped", reason: "github_user_missing" });
    const broken = fakeClient({ addToTeam: async () => { throw new Error("GitHub team add failed (403)"); } });
    expect(await syncMemberToGithub("student", 7, GITHUB, broken.client)).toEqual({ kind: "failed", error: "GitHub team add failed (403)" });
  });
});

describe("GitHub webhook", () => {
  const body = JSON.stringify({ action: "created", repository: { full_name: "glab-org/app", owner: { login: "GLAB-ORG" } }, sender: { id: 7 } });
  const sig = `sha256=${crypto.createHmac("sha256", GITHUB.webhookSecret).update(body).digest("hex")}`;

  it("verifies the HMAC signature", () => {
    expect(verifyGithubSignature(GITHUB.webhookSecret, body, sig)).toBe(true);
    expect(verifyGithubSignature(GITHUB.webhookSecret, body + " ", sig)).toBe(false);
    expect(verifyGithubSignature(GITHUB.webhookSecret, body, "sha1=abc")).toBe(false);
  });

  it("grants student-created repositories and records alumni-created ones without grants", async () => {
    const { client, calls } = fakeClient();
    const record = vi.fn(async () => {});
    const student = await handleGithubWebhook("repository", JSON.parse(body), { github: GITHUB, client, creatorStatus: async () => ({ userId: STUDENT, status: "student" }), record }, NOW);
    expect(student).toEqual({ handled: true, granted: 2 });
    expect(calls).toEqual(["grant:students:glab-org/app:push", "grant:alumni:glab-org/app:pull"]);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ repoFullName: "glab-org/app", creatorStatus: "student", grantedAt: NOW }));

    const alumni = fakeClient();
    const res = await handleGithubWebhook("repository", JSON.parse(body), { github: GITHUB, client: alumni.client, creatorStatus: async () => ({ userId: STUDENT, status: "alumni" }), record }, NOW);
    expect(res).toEqual({ handled: true, granted: 0 });
    expect(alumni.calls).toEqual([]);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ creatorStatus: "alumni", grantedAt: null }));
  });

  it("ignores other events and other owners", async () => {
    const { client, calls } = fakeClient();
    const deps = { github: GITHUB, client, creatorStatus: async () => null, record: async () => {} };
    expect(await handleGithubWebhook("push", {}, deps)).toEqual({ handled: false, reason: "ignored_event" });
    expect(await handleGithubWebhook("repository", { action: "deleted" }, deps)).toEqual({ handled: false, reason: "ignored_action" });
    expect(await handleGithubWebhook("repository", { action: "created", repository: { full_name: "x/y", owner: { login: "x" } } }, deps)).toEqual({ handled: false, reason: "other_owner" });
    expect(calls).toEqual([]);
  });
});

describe("glab_membership command", () => {
  const row = (over: Partial<GlabMemberRow> = {}): GlabMemberRow => ({ userId: STUDENT, displayName: "学生", orgRole: "member", githubId: 7, membership: null, ...over });
  function deps(role: string | null, rows: GlabMemberRow[] = [row()], config: GlabConfig | null = CONFIG) {
    const { client, calls } = fakeClient();
    const saved: unknown[] = [];
    const d: GlabCommandDeps = {
      config, client,
      actorRole: async () => role,
      list: async () => rows,
      save: async (_o, _u, next) => { saved.push(next); },
      recordSync: async () => {},
      now: () => NOW,
    };
    return { d, calls, saved };
  }

  it("lets leaders record a join and pushes it to the student team", async () => {
    const { d, calls, saved } = deps("leader");
    const res = await glabMembershipCommand(d, LEADER, "join", { userId: STUDENT }) as { status: string };
    expect(res.status).toBe("student");
    expect(saved).toEqual([{ status: "student", joinedAt: NOW, alumniAt: null }]);
    expect(calls).toEqual(["remove:alumni:Student-Login", "add:students:Student-Login"]);
  });

  it("rejects plain members, outsiders, self-changes and a disabled feature", async () => {
    await expect(glabMembershipCommand(deps("member").d, LEADER, "join", { userId: STUDENT })).rejects.toMatchObject({ statusCode: 403 });
    await expect(glabMembershipCommand(deps(null).d, LEADER, "list")).rejects.toMatchObject({ statusCode: 403 });
    await expect(glabMembershipCommand(deps("leader").d, STUDENT, "join", { userId: STUDENT })).rejects.toMatchObject({ statusCode: 403 });
    await expect(glabMembershipCommand(deps("leader", [], null).d, LEADER, "list")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("limits organization settings to system admins", async () => {
    await expect(glabMembershipCommand(deps("owner").d, LEADER, "apply_org_settings")).rejects.toMatchObject({ statusCode: 403 });
    const admin = deps("system_admin");
    await glabMembershipCommand(admin.d, LEADER, "apply_org_settings");
    expect(admin.calls).toEqual(["settings"]);
  });

  it("returns 409 for an invalid transition", async () => {
    await expect(glabMembershipCommand(deps("leader").d, LEADER, "graduate", { userId: STUDENT })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("config, app JWT, migration and panel rules", () => {
  it("keeps records enabled without GitHub, and disables everything without the organization", () => {
    expect(readGlabConfig({ CERNERE_GLAB_ORGANIZATION_ID: ORG } as NodeJS.ProcessEnv)).toEqual({ organizationId: ORG, github: null });
    expect(readGlabConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("signs the GitHub App JWT with RS256", () => {
    const [h, b, s] = createAppJwt("123", PEM, 1_000).split(".");
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iat: 940, exp: 1540, iss: "123" });
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("creates the tables idempotently without destructive statements", () => {
    const sql = readFileSync(new URL("../../../migrations/082_glab_membership_github.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS glab_memberships/);
    expect(sql).toMatch(/status IN \('student', 'alumni'\)/);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("never offers status changes on your own row", () => {
    const me = { userId: LEADER, displayName: "", orgRole: "leader", githubLinked: true, status: "student" as const, joinedAt: null, alumniAt: null, githubSyncedAt: null, githubSyncError: null };
    expect(rowActions(me, LEADER)).toEqual([]);
    expect(rowActions({ ...me, status: null }, STUDENT).map((a) => a.action)).toEqual(["join"]);
    expect(rowActions(me, STUDENT).map((a) => a.action)).toEqual(["graduate", "sync"]);
    expect(statusLabel("alumni")).toBe("OB");
  });
});
