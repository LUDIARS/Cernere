import { describe, expect, it, vi } from "vitest";
import { CompositeDelegations, delegationHeadersDigest, type DelegatedHttpOperation } from "../../../packages/composite/src/delegation.js";
import type { BoundServiceSession } from "../../../packages/composite/src/service-session.js";
const requestId = "22222222-2222-4222-8222-222222222222";
const operation: DelegatedHttpOperation & { requestId: string } = { action: "records.read", method: "GET", path: "/api/records/1?detail=1",
  resource: "/api/records/1?detail=1", body: "", headers: new Headers({ accept: "application/json" }), requestId };
const session = (): BoundServiceSession => ({ projectKey: "glab", projectToken: "scoped-source", sessionBinding: "s".repeat(43),
  user: { id: "subject", role: "member", displayName: "Person", email: null }, expiresAt: new Date(Date.now() + 600_000).toISOString() });
const issued = () => ({ delegationToken: "t".repeat(43), requestId, expiresAt: new Date(Date.now() + 25_000).toISOString() });
const consumed = () => ({ allowed: true, requestId, projectKey: "aedilis", sourceProject: "glab", risk: "sensitive_read", user: session().user, expiresAt: issued().expiresAt });
describe("shared delegation SDK boundary", () => {
  it("binds even a sensitive GET to the exact URL and empty-body digest", async () => {
    const call = vi.fn(async (_action: string, _body: unknown) => issued());
    const client = new CompositeDelegations(call, "glab");
    await client.issue(session(), { projectKey: "aedilis", audience: "https://aedilis.example" }, operation);
    expect(call).toHaveBeenCalledExactlyOnceWith("delegate", expect.objectContaining({
      projectToken: "scoped-source", sessionBinding: "s".repeat(43), targetProject: "aedilis", targetAudience: "https://aedilis.example",
      method: "GET", action: "records.read", path: operation.path, resource: operation.path, requestId,
      contentDigest: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    }));
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });
  it("does not retry issuance/consumption on timeout or unknown authority outcomes", async () => {
    const call = vi.fn(async () => { throw new Error("unknown outcome"); });
    const client = new CompositeDelegations(call, "glab");
    await expect(client.issue(session(), { projectKey: "aedilis", audience: "https://aedilis.example" }, operation)).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
    const target = new CompositeDelegations(call, "aedilis");
    const execute = vi.fn();
    await expect(target.run("t".repeat(43), operation, { risk: "sensitive_read", authorizeResource: () => true, execute })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });
  it("runs latest destination authorization only after one-use consumption, directly before execute", async () => {
    const order: string[] = [];
    const client = new CompositeDelegations(async () => { order.push("consume"); return consumed(); }, "aedilis");
    const result = await client.run("t".repeat(43), operation, {
      risk: "sensitive_read", authorizeResource: decision => { order.push("resource"); return decision.user.id === "subject"; },
      execute: decision => { order.push("execute"); return decision.requestId; },
    });
    expect(result).toBe(requestId);
    expect(order).toEqual(["consume", "resource", "execute"]);
  });
  it("never executes when current destination data authorization denies", async () => {
    const client = new CompositeDelegations(async () => consumed(), "aedilis");
    const execute = vi.fn();
    await expect(client.run("t".repeat(43), operation, { risk: "sensitive_read", authorizeResource: () => false, execute })).rejects.toThrow("resource");
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ projectKey: "other" }, { sourceProject: "aedilis" }, { allowed: false }, { requestId: "other" }, { risk: "read" }, { risk: undefined },
    { expiresAt: new Date(0).toISOString() }, { expiresAt: new Date(Date.now() + 60_000).toISOString() }])("rejects invalid/foreign destination responses", async change => {
    const client = new CompositeDelegations(async () => ({ ...consumed(), ...change }), "aedilis");
    const execute = vi.fn();
    await expect(client.run("t".repeat(43), operation, { risk: "sensitive_read", authorizeResource: () => true, execute })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["accessToken", "refreshToken", "projectToken", "sessionToken"])("rejects a reusable %s mixed into a response", async field => {
    const client = new CompositeDelegations(async () => ({ ...issued(), [field]: "unexpected" }), "glab");
    await expect(client.issue(session(), { projectKey: "aedilis", audience: "https://aedilis.example" }, operation)).rejects.toThrow();
  });
  it("rejects noncanonical paths and a source session from another service", async () => {
    const call = vi.fn();
    const client = new CompositeDelegations(call, "glab");
    await expect(client.issue(session(), { projectKey: "aedilis", audience: "https://aedilis.example" }, { ...operation, path: "//other.example/", resource: "//other.example/" })).rejects.toThrow();
    await expect(client.issue({ ...session(), projectKey: "other" }, { projectKey: "aedilis", audience: "https://aedilis.example" }, operation)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it("binds content interpretation, conditional reads and route-owned semantic headers", () => {
    const first = new Headers({ "content-type": "application/json", "if-match": '"version-1"', "x-organization": "a" });
    const same = new Headers({ "X-Organization": "a", "If-Match": '"version-1"', "Content-Type": "application/json" });
    expect(delegationHeadersDigest(first, ["x-organization"])).toBe(delegationHeadersDigest(same, ["X-Organization"]));
    for (const [name, value] of [["content-type", "text/plain"], ["if-match", "*"], ["x-organization", "b"]]) {
      const changed = new Headers(first); changed.set(name!, value!);
      expect(delegationHeadersDigest(changed, ["x-organization"])).not.toBe(delegationHeadersDigest(first, ["x-organization"]));
    }
    expect(() => delegationHeadersDigest(first, ["authorization"])).toThrow();
  });
});
