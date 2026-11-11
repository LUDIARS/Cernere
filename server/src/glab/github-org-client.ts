/**
 * GLab の GitHub 組織への操作 (チーム所属・チームのリポジトリ権限・組織設定・login の解決)。
 * 失敗は GithubApiError にして呼出し側で記録する。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import type { GlabGithubConfig } from "./glab-config.js";
import { GithubApiError, type GithubRequest } from "./github-app.js";
import { GLAB_ORG_SETTINGS, type RepoPermission } from "./membership-policy.js";

export interface GithubOrgClient {
  loginForId(githubId: number): Promise<string | null>;
  addToTeam(team: string, login: string): Promise<void>;
  removeFromTeam(team: string, login: string): Promise<void>;
  teamMembers(team: string): Promise<string[]>;
  grantTeamRepo(team: string, repoFullName: string, permission: RepoPermission): Promise<void>;
  applyOrgSettings(): Promise<void>;
}

function ensure(status: number, ok: number[], what: string): void {
  if (!ok.includes(status)) throw new GithubApiError(`GitHub ${what} failed (${status})`, status);
}

const enc = encodeURIComponent;

export function createGithubOrgClient(config: GlabGithubConfig, request: GithubRequest): GithubOrgClient {
  const org = enc(config.org);
  return {
    async loginForId(githubId) {
      const res = await request("GET", `/user/${githubId}`);
      if (res.status === 404) return null;
      ensure(res.status, [200], "user lookup");
      const login = (res.data as { login?: unknown }).login;
      return typeof login === "string" ? login : null;
    },
    async addToTeam(team, login) {
      // 組織に未参加なら GitHub が招待を送る (state: pending)。
      const res = await request("PUT", `/orgs/${org}/teams/${enc(team)}/memberships/${enc(login)}`, { role: "member" });
      ensure(res.status, [200], "team add");
    },
    async removeFromTeam(team, login) {
      const res = await request("DELETE", `/orgs/${org}/teams/${enc(team)}/memberships/${enc(login)}`);
      ensure(res.status, [204, 404], "team remove");
    },
    async teamMembers(team) {
      const logins: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await request("GET", `/orgs/${org}/teams/${enc(team)}/members?per_page=100&page=${page}`);
        ensure(res.status, [200], "team members");
        const rows = Array.isArray(res.data) ? res.data as Array<{ login?: unknown }> : [];
        for (const row of rows) if (typeof row.login === "string") logins.push(row.login);
        if (rows.length < 100) break;
      }
      // 招待中 (未承諾) の人もチームの一員として数える。
      const invites = await request("GET", `/orgs/${org}/teams/${enc(team)}/invitations?per_page=100`);
      if (invites.status === 200 && Array.isArray(invites.data)) {
        for (const row of invites.data as Array<{ login?: unknown }>) if (typeof row.login === "string") logins.push(row.login);
      }
      return [...new Set(logins)];
    },
    async grantTeamRepo(team, repoFullName, permission) {
      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) throw new GithubApiError("Invalid repository name", 400);
      const res = await request("PUT", `/orgs/${org}/teams/${enc(team)}/repos/${enc(owner)}/${enc(repo)}`, { permission });
      ensure(res.status, [204], "team repo grant");
    },
    async applyOrgSettings() {
      const res = await request("PATCH", `/orgs/${org}`, GLAB_ORG_SETTINGS);
      ensure(res.status, [200], "org settings");
    },
  };
}
