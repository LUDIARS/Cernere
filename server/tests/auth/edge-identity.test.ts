/**
 * get-identity の取得と identity_nonce キャッシュ。
 *
 * Redis は in-memory スタブに差し替え、 fetch はすべてスタブする。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("../../src/redis.js", () => ({
  redis: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
  },
}));

const { fetchEdgeIdentity } = await import("../../src/auth/edge-identity.js");

const TEAM = "example.cloudflareaccess.com";
const COOKIE = "cf-authorization-cookie-value";

function identityResponse(body: Record<string, unknown>): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const FULL_IDENTITY = {
  email: "taro@example.co.jp",
  name: "山田 太郎",
  user_uuid: "cf-uuid-1",
  idp: { id: "idp-1", type: "google" },
  groups: [{ id: "g-1", name: "engineering" }, { id: "g-2", name: "all" }],
  amr: ["pwd", "mfa"],
};

describe("fetchEdgeIdentity", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns user_uuid / name / groups / idp type / amr", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse(FULL_IDENTITY));

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(identity).toEqual({
      email: "taro@example.co.jp",
      name: "山田 太郎",
      userUuid: "cf-uuid-1",
      idpType: "google",
      groups: [{ id: "g-1", name: "engineering" }, { id: "g-2", name: "all" }],
      amr: ["pwd", "mfa"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://${TEAM}/cdn-cgi/access/get-identity`,
      {
        headers: { cookie: `CF_Authorization=${COOKIE}` },
        redirect: "error",
      },
    );
  });

  it("serves the second call for the same identity_nonce from cache (one upstream call)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse(FULL_IDENTITY));

    const first = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);
    const second = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not share cache across different nonces", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse(FULL_IDENTITY));

    await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);
    await fetchEdgeIdentity(TEAM, "nonce-2", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null when the upstream call fails (caller keeps groups empty)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(identity).toBeNull();
    // 失敗はキャッシュしない (次回は取り直す)。
    expect(store.size).toBe(0);
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as unknown as Response);

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(identity).toBeNull();
  });

  it("returns null without calling upstream when no CF_Authorization cookie was forwarded", async () => {
    const fetchImpl = vi.fn();

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", "", fetchImpl as unknown as typeof fetch);

    expect(identity).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tolerates a response without groups or name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse({ email: "taro@example.co.jp" }));

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(identity).toEqual({
      email: "taro@example.co.jp",
      name: null,
      userUuid: null,
      idpType: null,
      groups: [],
      amr: [],
    });
  });

  it("drops malformed group entries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse({
      ...FULL_IDENTITY,
      groups: [{ id: "g-1", name: "engineering" }, "broken", null, {}],
    }));

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(identity?.groups).toEqual([{ id: "g-1", name: "engineering" }]);
  });

  // cfAuthorization は Hub から来る未検証の文字列で、 cookie ヘッダに直接埋まる。
  it.each([
    ["a semicolon (extra cookie)", "token; CF_Authorization=attacker"],
    ["a CR/LF (header split)", "token\r\nX-Injected: 1"],
    ["a space", "token attacker"],
  ])("refuses to call upstream when the cookie value contains %s", async (_label, cookie) => {
    const fetchImpl = vi.fn();

    const identity = await fetchEdgeIdentity(TEAM, "nonce-1", cookie, fetchImpl as unknown as typeof fetch);

    expect(identity).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not share cache across team domains for the same nonce", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(identityResponse(FULL_IDENTITY));

    await fetchEdgeIdentity(TEAM, "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);
    await fetchEdgeIdentity("other.cloudflareaccess.com", "nonce-1", COOKIE, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
