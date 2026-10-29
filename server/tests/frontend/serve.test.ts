import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildStaticManifest, cacheControl, lookupStatic } from "../../../frontend/serve/static-files.mjs";
import { parseRequestTarget } from "../../../frontend/serve/request-target.mjs";
import { forwardHeaders, isBackendPath, isUpgradePath, upgradeRequestHead } from "../../../frontend/serve/backend-proxy.mjs";
import { createFramePolicySource } from "../../../frontend/serve/frame-policy.mjs";

let root: string;
let dist: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cernere-serve-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  writeFileSync(join(dist, "assets", "app-1a_B.js"), "x");
  writeFileSync(join(dist, "assets", "app-1a_B.js.map"), "{}");
  writeFileSync(join(dist, ".env"), "SECRET=1");
  writeFileSync(join(dist, "notes.unknown"), "x");
  writeFileSync(join(root, "secret.txt"), "outside");
  try { symlinkSync(join(root, "secret.txt"), join(dist, "linked.txt")); } catch { /* Windows without symlink rights */ }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("frontend static manifest", () => {
  it("lists only regular, safely named, known-type files under dist", () => {
    const manifest = buildStaticManifest(dist);
    expect([...manifest.keys()].sort()).toEqual(["/assets/app-1a_B.js", "/favicon.svg", "/index.html"]);
  });

  it("refuses to start without a built index.html", () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(() => buildStaticManifest(empty)).toThrow(/index\.html/);
  });

  it("serves exact entries and falls back to index.html only for screen paths", () => {
    const manifest = buildStaticManifest(dist);
    expect(lookupStatic(manifest, "/assets/app-1a_B.js")).toMatchObject({ file: join(dist, "assets", "app-1a_B.js"), spaFallback: false });
    expect(lookupStatic(manifest, "/")).toMatchObject({ file: join(dist, "index.html"), spaFallback: true });
    expect(lookupStatic(manifest, "/login/composite")).toMatchObject({ file: join(dist, "index.html"), spaFallback: true });
    for (const p of ["/assets/app-1a_B.js.map", "/.env", "/linked.txt", "/missing.js", "/a%2e%2e/x", "/notes.unknown"]) {
      expect(lookupStatic(manifest, p)).toBeNull();
    }
  });

  it("sets caching", () => {
    expect(cacheControl("/assets/app-1.js", false)).toMatch(/immutable/);
    expect(cacheControl("/login", true)).toBe("no-cache");
    expect(cacheControl("/favicon.ico", false)).toBe("public, max-age=3600");
  });
});

describe("frontend request target", () => {
  it("accepts origin-form paths and keeps the query", () => {
    expect(parseRequestTarget("/api/auth/me?x=1")).toEqual({ pathname: "/api/auth/me", path: "/api/auth/me?x=1" });
    expect(parseRequestTarget("/")).toEqual({ pathname: "/", path: "/" });
  });

  it.each([
    "http://evil.example/api/x", "*", "//evil.example/x", "api/x",
    "/../etc/passwd", "/assets/../api/admin", "/./index.html", "/%2e%2e/x", "/assets/..%2f..%2fx",
    "/a%2fb", "/a%5cb", "/a\\b", "/x%00.js", "/a b", "/a\tb", `/${"a".repeat(5000)}`,
  ])("rejects %s", (target) => {
    expect(parseRequestTarget(target)).toBeNull();
  });
});

describe("frontend backend proxy", () => {
  it("routes the same backend paths as the vite proxy", () => {
    for (const p of ["/api/auth/me", "/auth", "/auth/github/callback", "/ws/project", "/.well-known/jwks.json"]) expect(isBackendPath(p)).toBe(true);
    for (const p of ["/", "/login", "/apix", "/authority", "/assets/a.js"]) expect(isBackendPath(p)).toBe(false);
    expect(isUpgradePath("/auth")).toBe(true);
    expect(isUpgradePath("/auth/composite-ws")).toBe(true);
    expect(isUpgradePath("/api/auth/me")).toBe(false);
  });

  it("points Host at the backend, drops hop-by-hop headers and keeps CF-Connecting-IP", () => {
    const backend = new URL("http://127.0.0.1:8086");
    const out = forwardHeaders({ host: "cr.example", connection: "keep-alive", "cf-connecting-ip": "203.0.113.7", cookie: "a=b" }, backend);
    expect(out).toEqual({ host: "127.0.0.1:8086", "cf-connecting-ip": "203.0.113.7", cookie: "a=b" });
  });

  it("writes the normalized path, not the raw request line, for upgrades", () => {
    const backend = new URL("http://127.0.0.1:8086");
    const head = upgradeRequestHead({ method: "GET", url: "/raw/../auth", headers: { host: "cr.example", upgrade: "websocket" } }, backend, "/auth");
    expect(head).toBe("GET /auth HTTP/1.1\r\nhost: 127.0.0.1:8086\r\nupgrade: websocket\r\n\r\n");
  });
});

describe("frontend frame policy cache", () => {
  it("reuses a fetched policy within the ttl and fails closed on errors", async () => {
    let now = 0;
    const fetchOrigins = vi.fn(async () => ["https://glab.example"]);
    const policy = createFramePolicySource(fetchOrigins, { ttlMs: 1000, now: () => now });
    await expect(policy()).resolves.toBe("frame-ancestors 'self' https://glab.example");
    await policy();
    expect(fetchOrigins).toHaveBeenCalledTimes(1);
    now = 2000;
    fetchOrigins.mockRejectedValueOnce(new Error("offline"));
    await expect(policy()).rejects.toThrow("offline");
  });
});
