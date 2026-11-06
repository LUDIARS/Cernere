import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../packages/native-composite/src/identity.js", () => ({ localIdentity: async () => "installation-id" }));
import { NativeComposite } from "../../../packages/native-composite/src/client.js";
afterEach(() => vi.unstubAllGlobals());
const code = "c".repeat(43);
const options = { cernereUrl: "https://cr.example", serviceUrl: "https://glab.example", clientId: "glab-client" };

describe("native service-specific session", () => {
  it("keeps the verifier in the host and exchanges only at its configured service", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sessionToken: "s".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() }) });
    vi.stubGlobal("fetch", fetcher);
    const host = new NativeComposite(options);
    const url = new URL(host.loginUrl("https://glab.example"));
    expect(url.searchParams.get("client_id")).toBe("glab-client");
    expect(url.searchParams.has("code_verifier")).toBe(false);
    await host.exchange(code, url.searchParams.get("state")!);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://glab.example/api/auth/native/exchange");
    const request = JSON.parse(fetcher.mock.calls[0]?.[1].body as string);
    expect(createHash("sha256").update(request.code_verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(host.hasSession).toBe(true);
    await expect(host.authorized("https://other.example/data")).rejects.toThrow("Unconfigured");
    host.dispose(); expect(host.hasSession).toBe(false);
  });
  it("rejects wrong state and does not retry a consumed exchange", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("unknown exchange result")); vi.stubGlobal("fetch", fetcher);
    const host = new NativeComposite(options);
    const url = new URL(host.loginUrl("https://glab.example"));
    await expect(host.exchange(code, "wrong")).rejects.toThrow("Invalid");
    expect(fetcher).not.toHaveBeenCalled();
    const next = new URL(host.loginUrl("https://glab.example"));
    await expect(host.exchange(code, next.searchParams.get("state")!)).rejects.toThrow("unknown exchange result");
    await expect(host.exchange(code, next.searchParams.get("state")!)).rejects.toThrow("Invalid");
    expect(fetcher).toHaveBeenCalledOnce(); host.dispose();
    expect(url.searchParams.get("state")).not.toBe(next.searchParams.get("state"));
  });
  it("rejects any response exposing Cernere credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sessionToken: "s".repeat(43),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), refreshToken: "forbidden" }) });
    vi.stubGlobal("fetch", fetcher);
    const host = new NativeComposite(options);
    const url = new URL(host.loginUrl("https://glab.example"));
    await expect(host.exchange(code, url.searchParams.get("state")!)).rejects.toThrow("Invalid service session response");
    expect(host.hasSession).toBe(false); host.dispose();
  });
});
