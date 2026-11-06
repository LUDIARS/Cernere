import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompositeServiceSessions, type BoundServiceSession } from "../../../packages/composite/src/service-session.js";

const session: BoundServiceSession = { projectToken: "project-token", sessionBinding: "s".repeat(43), projectKey: "glab",
  expiresAt: new Date(Date.now() + 600_000).toISOString(), user: { id: "user", displayName: "User", email: null, role: "general" } };
const operation = { action: "profile.read", resource: "profile:1", body: "exact request bytes", requestId: "11111111-1111-4111-8111-111111111111" };
describe("common service operation SDK gate", () => {
  it("binds the opaque session digest, never the session secret", async () => {
    const call = vi.fn().mockResolvedValue(session);
    const client = new CompositeServiceSessions(call);
    const secret = "opaque-session".repeat(4);
    await client.bind("project-token", secret);
    expect(call).toHaveBeenCalledWith("bind", { projectToken: "project-token", sessionBinding: createHash("sha256").update(secret).digest("base64url") });
  });
  it("consumes a matching permit before the latest resource authorization and execution", async () => {
    const order: string[] = [];
    const call = vi.fn(async (action: string) => {
      order.push(action);
      return action === "authorize" ? { permit: "p".repeat(43), expiresIn: 30, risk: "sensitive_read" } : { allowed: true, requestId: operation.requestId, risk: "sensitive_read" };
    });
    const client = new CompositeServiceSessions(call);
    await expect(client.run(session, operation, { risk: "sensitive_read", authorizeResource: () => { order.push("resource"); return true; }, execute: () => { order.push("execute"); return "result"; } })).resolves.toBe("result");
    expect(order).toEqual(["authorize", "consume", "resource", "execute"]);
    expect(call.mock.calls[1]?.[0]).toBe("consume");
  });
  it("fails closed if the authority is unavailable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("unavailable"));
    const execute = vi.fn();
    await expect(new CompositeServiceSessions(call).run(session, operation, { risk: "sensitive_read", authorizeResource: () => true, execute })).rejects.toThrow("unavailable");
    expect(execute).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledOnce();
  });
  it("does not execute after current target-data authorization denies", async () => {
    const call = vi.fn(async (action: string) => action === "authorize" ? { permit: "p".repeat(43), expiresIn: 30, risk: "important" } : { allowed: true, requestId: operation.requestId, risk: "important" });
    const execute = vi.fn();
    await expect(new CompositeServiceSessions(call).run(session, operation, { risk: "important", authorizeResource: () => false, execute })).rejects.toThrow("resource access denied");
    expect(execute).not.toHaveBeenCalled();
  });
  it("never retries a service operation with an unknown result", async () => {
    const call = vi.fn(async (action: string) => action === "authorize" ? { permit: "p".repeat(43), expiresIn: 30, risk: "important" } : { allowed: true, requestId: operation.requestId, risk: "important" });
    const execute = vi.fn().mockRejectedValue(new Error("unknown database result"));
    await expect(new CompositeServiceSessions(call).run(session, operation, { risk: "important", authorizeResource: () => true, execute })).rejects.toThrow("unknown database result");
    expect(execute).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledTimes(2);
  });
  it("requires local classification and rejects a central risk mismatch before consuming", async () => {
    const call = vi.fn(async () => ({ permit: "p".repeat(43), expiresIn: 30, risk: "read" }));
    const execute = vi.fn();
    await expect(new CompositeServiceSessions(call).run(session, operation, {
      risk: "sensitive_read", authorizeResource: () => true, execute,
    })).rejects.toThrow("risk mismatch");
    expect(call).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it("rejects policy drift between authorization and consumption", async () => {
    const call = vi.fn(async (action: string) => action === "authorize"
      ? { permit: "p".repeat(43), expiresIn: 30, risk: "sensitive_read" }
      : { allowed: true, requestId: operation.requestId, risk: "important" });
    const execute = vi.fn();
    await expect(new CompositeServiceSessions(call).run(session, operation, {
      risk: "sensitive_read", authorizeResource: () => true, execute,
    })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
