import { afterEach, describe, expect, it, vi } from "vitest";
import { CernereComposite } from "../../../packages/composite/src/composite.js";
const config = { cernereUrl: "https://cr.example", projectKey: "glab", clientId: "glab-client", clientSecret: "test-project-secret" };
const verifier = "v".repeat(43);
const user = { id: "user", displayName: "User", email: null, role: "general" };
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const credential = () => response({ tokenType: "project", accessToken: "project-credential", expiresIn: 3600, project: { key: "glab" } });
afterEach(() => vi.unstubAllGlobals());
describe("Composite backend project credentials", () => {
  it("opens no startup socket and exchanges only with this project's bearer", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(credential()).mockResolvedValueOnce(response({ projectToken: "scoped-paseto", user }));
    vi.stubGlobal("fetch", fetcher);
    const client = new CernereComposite(config);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.exchange("code", verifier)).resolves.toEqual({ projectToken: "scoped-paseto", user });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://cr.example/api/auth/login");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://cr.example/api/auth/exchange");
    expect(fetcher.mock.calls[1]?.[1].headers.authorization).toBe("Bearer project-credential");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ code: "code", code_verifier: verifier });
    client.dispose();
  });
  it("rejects an authentication response for another project", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ tokenType: "project", accessToken: "credential", expiresIn: 3600, project: { key: "other" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new CernereComposite(config);
    await expect(client.exchange("code", verifier)).rejects.toThrow("Invalid project credential response");
    expect(fetcher).toHaveBeenCalledOnce(); client.dispose();
  });
  it("rejects the old global user token response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(credential()).mockResolvedValueOnce(response({ accessToken: "old-access", refreshToken: "old-refresh", user }));
    vi.stubGlobal("fetch", fetcher);
    const client = new CernereComposite(config);
    await expect(client.exchange("code", verifier)).rejects.toThrow("Invalid Cernere exchange response");
    client.dispose();
  });
  it("aborts disposal during authentication without proceeding to code exchange", async () => {
    let finish: ((value: Response) => void) | undefined;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const client = new CernereComposite(config);
    const pending = client.exchange("code", verifier);
    client.dispose(); finish!(credential());
    await expect(pending).rejects.toThrow("disposed");
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never sends project credentials to a non-loopback HTTP origin", () => {
    expect(() => new CernereComposite({ ...config, cernereUrl: "http://cr.example" })).toThrow("HTTPS");
  });
});
