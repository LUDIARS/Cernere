import { afterEach, describe, expect, it, vi } from "vitest";
import { EnterpriseSessionClient } from "../../../packages/service-adapter/src/enterprise-client.js";
import { createEnterpriseAuthMiddleware } from "../../../packages/service-adapter/src/enterprise-middleware.js";

const token = "ces_" + "a".repeat(43);
function session(projectKey = "demo") {
  return { projectKey, userId: "user", organizationId: "org", organizationRole: "member",
    authTime: Math.floor(Date.now() / 1000) - 10, amr: ["mfa"], expiresAt: Math.floor(Date.now() / 1000) + 600 };
}
afterEach(() => { vi.useRealTimers(); });

describe("enterprise adapter guards", () => {
  it("refuses ordinary tokens without asking the transport and rejects another project", async () => {
    const request = vi.fn(async () => session("other"));
    const client = new EnterpriseSessionClient("demo", request);
    await expect(client.verify("ordinary.jwt.token")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(client.verify(token)).rejects.toThrow();
  });
  it("closes an idle downstream connection when its authorization is revoked and clears timers", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(session()).mockRejectedValue(new Error("revoked"));
    const client = new EnterpriseSessionClient("demo", request);
    const revoked = vi.fn();
    const stop = await client.watch(token, revoked);
    await vi.advanceTimersByTimeAsync(15000);
    expect(revoked).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fails closed when the authorization transport stops responding", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(session()).mockImplementation(() => new Promise(() => {}));
    const client = new EnterpriseSessionClient("demo", request);
    const revoked = vi.fn();
    const stop = await client.watch(token, revoked);
    await vi.advanceTimersByTimeAsync(25000);
    expect(revoked).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels watch timers on downstream close", async () => {
    vi.useFakeTimers();
    const client = new EnterpriseSessionClient("demo", async () => session());
    const controller = new AbortController();
    const revoked = vi.fn();
    await client.watch(token, revoked, controller.signal);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(revoked).not.toHaveBeenCalled();
  });
  it("never runs a protected operation on verification failure", async () => {
    const client = new EnterpriseSessionClient("demo", async () => { throw new Error("unavailable"); });
    const middleware = createEnterpriseAuthMiddleware(client);
    const next = vi.fn(async () => {});
    const response = await middleware({ req: { header: () => "Bearer " + token }, set: vi.fn(),
      json: (data, status) => new Response(JSON.stringify(data), { status }) }, next);
    expect(response?.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
