/**
 * 設定から GitHub クライアントを組み立てる (プロセス内で 1 つを使い回し、installation token を共有する)。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import { readGlabConfig, type GlabConfig } from "./glab-config.js";
import { createGithubRequest } from "./github-app.js";
import { createGithubOrgClient, type GithubOrgClient } from "./github-org-client.js";

let cache: { key: string; client: GithubOrgClient } | null = null;

export function glabRuntime(): { config: GlabConfig | null; client: GithubOrgClient | null } {
  const config = readGlabConfig();
  if (!config?.github) return { config, client: null };
  const key = `${config.github.appId}:${config.github.installationId}:${config.github.org}`;
  if (!cache || cache.key !== key) cache = { key, client: createGithubOrgClient(config.github, createGithubRequest(config.github)) };
  return { config, client: cache.client };
}
