/**
 * GitHub App 認証 (app JWT → installation token) と API 呼出し。
 * installation token は期限の 1 分前まで使い回す。秘密鍵・トークンはログに出さない。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import crypto from "node:crypto";
import type { GlabGithubConfig } from "./glab-config.js";

const API = "https://api.github.com";

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "GithubApiError"; }
}

/** GitHub App の JWT (RS256、有効 9 分、時計のずれ対策で 60 秒前から)。 */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iat: nowSec - 60, exp: nowSec + 540, iss: appId });
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKeyPem).toString("base64url");
  return `${head}.${body}.${signature}`;
}

export interface GithubRequest {
  (method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
}

export function createGithubRequest(config: GlabGithubConfig, fetchImpl: typeof fetch = fetch): GithubRequest {
  let cached: { token: string; expiresAt: number } | null = null;

  async function installationToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const res = await fetchImpl(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${createAppJwt(config.appId, config.privateKeyPem)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new GithubApiError(`GitHub App installation token failed (${res.status})`, res.status);
    const data = await res.json() as { token?: string; expires_at?: string };
    if (!data.token) throw new GithubApiError("GitHub App installation token missing", 502);
    cached = { token: data.token, expiresAt: data.expires_at ? Date.parse(data.expires_at) : Date.now() + 30 * 60_000 };
    return data.token;
  }

  return async (method, path, body) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${await installationToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  };
}
