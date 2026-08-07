import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/redis.js", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => { store.delete(key); }),
  },
}));

vi.mock("../../src/config.js", () => ({
  config: {
    githubClientId: "github-id",
    githubClientSecret: "github-secret",
    githubRedirectUri: "https://auth.example.com/auth/github/callback",
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    googleRedirectUri: "https://auth.example.com/auth/google/callback",
    discordClientId: "discord-id",
    discordClientSecret: "discord-secret",
    discordRedirectUri: "https://auth.example.com/auth/discord/callback",
  },
}));

const { createOAuthLinkGrant, loadOAuthLinkGrant } = await import("../../src/auth/oauth-link.js");

describe("OAuth link grants", () => {
  beforeEach(() => store.clear());

  it.each(["github", "google", "discord"] as const)(
    "stores an opaque browser-bound grant for %s",
    async (provider) => {
      const start = await createOAuthLinkGrant(provider, "user-1");
      expect(start.state).toMatch(/^link:[0-9a-f-]+$/i);
      expect(start.state).not.toContain("user-1");
      expect(await loadOAuthLinkGrant(start.state, provider)).toEqual({
        userId: "user-1",
        provider,
      });
    },
  );

  it("requests only identity scopes for GitHub linking", async () => {
    const start = await createOAuthLinkGrant("github", "user-1");
    const scope = new URL(start.authorizationUrl).searchParams.get("scope") ?? "";
    expect(scope).toContain("read:user");
    expect(scope).not.toContain("repo");
  });

  it("does not request an offline Google refresh token for identity linking", async () => {
    const start = await createOAuthLinkGrant("google", "user-1");
    const query = new URL(start.authorizationUrl).searchParams;
    expect(query.has("access_type")).toBe(false);
    expect(query.has("prompt")).toBe(false);
  });

  it("rejects malformed cached grants instead of granting authority", async () => {
    store.set("oauthlink:link:bad", "null");
    expect(await loadOAuthLinkGrant("link:bad", "github")).toBeNull();
  });

  it("does not accept a state at another provider callback", async () => {
    const start = await createOAuthLinkGrant("github", "user-1");
    expect(await loadOAuthLinkGrant(start.state, "google")).toBeNull();
  });
});
