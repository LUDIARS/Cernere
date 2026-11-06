import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompositeUploads, type IncomingUploadOperation, type UploadCapture, type UploadHttpOperation } from "../../../packages/composite/src/upload.js";
import { CompositeServiceSessions, type AuthorityCall, type BoundServiceSession } from "../../../packages/composite/src/service-session.js";

const token = "t".repeat(43), requestId = "22222222-2222-4222-8222-222222222222";
const digest = (body: string) => createHash("sha256").update(body).digest("base64url");
const headers = () => new Headers({ "content-type": "video/mp4", accept: "*/*", "accept-language": "*" });
const session = (): BoundServiceSession => ({ projectToken: "source-scoped", sessionBinding: "s".repeat(43), projectKey: "glab",
  expiresAt: new Date(Date.now() + 600_000).toISOString(), user: { id: "subject", role: "member", displayName: "Person", email: null } });
const operation = (): IncomingUploadOperation => ({ action: "media.write", method: "PUT", path: "/api/media/1", resource: "/api/media/1", requestId, headers: headers() });

function targetFixture(options: { denied?: boolean; authorityFailure?: boolean; changed?: boolean; ownerEnds?: boolean; replaceDuringAcl?: boolean } = {}) {
  const events: string[] = [], expiresAt = new Date(Date.now() + 240_000).toISOString();
  const original = new Blob([options.changed ? "tampered" : "private"]);
  const captured: UploadCapture = { body: original, dispose: async () => { events.push("dispose"); } };
  let current = true;
  const call: AuthorityCall = async (action, raw) => {
    events.push(action); const body = raw as Record<string, unknown>;
    if (action === "begin-upload") return { receipt: token, requestId, risk: "important", contentDigest: digest("private"), byteLength: 7,
      limits: { maximumBytes: 1024, timeoutSeconds: 300 }, expiresAt };
    if (action === "cancel-upload") return { cancelled: true };
    if (options.authorityFailure) throw new Error("offline");
    expect(body.contentDigest).toBe(digest("private")); expect(body.byteLength).toBe(7);
    if (options.ownerEnds) current = false;
    return { allowed: true, requestId, risk: "important", expiresAt, projectKey: "volputas", sourceProject: "glab", user: session().user };
  };
  const resource = { risk: "important" as const, limits: { maximumBytes: 1024, timeoutSeconds: 300 }, isCurrent: () => current,
    capture: async () => { events.push("capture"); return captured; },
    authorizeResource: async () => { events.push("acl"); if (options.replaceDuringAcl) captured.body = new Blob(["replaced"]); return !options.denied; },
    execute: async (body: Blob) => { events.push("execute"); expect(body).toBe(original); return body.text(); } };
  return { sdk: new CompositeUploads(call, "volputas"), resource, events };
}

describe("bounded upload SDK", () => {
  it("hashes source Blob bytes without accepting an external digest or mutable envelope", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let currentOperation: UploadHttpOperation;
    class Captured extends Blob {
      override stream() { currentOperation.path = currentOperation.resource = "/changed-during-read"; return super.stream(); }
    }
    currentOperation = { ...operation(), body: new Captured(["private"]) };
    const sdk = new CompositeUploads(async (action, raw) => {
      expect(action).toBe("delegate-upload"); calls.push(raw as Record<string, unknown>);
      return { arrivalToken: token, requestId, expiresAt: new Date(Date.now() + 29_000).toISOString() };
    }, "glab");
    await sdk.issue(session(), { projectKey: "volputas", audience: "https://vo.example" }, currentOperation, { risk: "important", isCurrent: () => true });
    expect(calls[0]).toMatchObject({ path: "/api/media/1", resource: "/api/media/1", contentDigest: digest("private"), byteLength: 7,
      targetProject: "volputas", projectToken: "source-scoped" });
  });
  it("reserves before capture and finalizes before current target ACL and execution", async () => {
    const f = targetFixture();
    await expect(f.sdk.run(token, operation(), f.resource)).resolves.toBe("private");
    expect(f.events).toEqual(["begin-upload", "capture", "finalize-upload", "acl", "execute", "dispose"]);
  });
  it("executes exactly the captured Blob even if a callback replaces a mutable wrapper", async () => {
    const f = targetFixture({ replaceDuringAcl: true });
    await expect(f.sdk.run(token, operation(), f.resource)).resolves.toBe("private");
  });
  it("rejects changed bytes before finalization and releases local bytes before remote cancellation", async () => {
    const f = targetFixture({ changed: true });
    await expect(f.sdk.run(token, operation(), f.resource)).rejects.toThrow("reserved body");
    expect(f.events).toEqual(["begin-upload", "capture", "dispose", "cancel-upload"]);
  });
  it.each([{ denied: true }, { authorityFailure: true }, { ownerEnds: true }])("does not execute after a denied or unknown result: %j", async options => {
    const f = targetFixture(options);
    await expect(f.sdk.run(token, operation(), f.resource)).rejects.toThrow();
    expect(f.events).not.toContain("execute"); expect(f.events).toContain("dispose");
    expect(f.events.filter(event => event === "finalize-upload")).toHaveLength(1);
  });
  it("cancels an acquired reservation if private capture cannot be allocated", async () => {
    const f = targetFixture(); f.resource.capture = async () => { throw new Error("spool budget full"); };
    await expect(f.sdk.run(token, operation(), f.resource)).rejects.toThrow("spool budget");
    expect(f.events).toEqual(["begin-upload", "cancel-upload"]);
  });
  it("does not acquire authority for an ended owner or a missing route limit", async () => {
    const f = targetFixture();
    await expect(f.sdk.run(token, operation(), { ...f.resource, isCurrent: () => false })).rejects.toThrow();
    await expect(f.sdk.run(token, operation(), { ...f.resource, limits: { maximumBytes: 0, timeoutSeconds: 300 } })).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("does not turn an unknown execution result into another finalization attempt", async () => {
    const f = targetFixture(); f.resource.execute = async () => { f.events.push("execute"); throw new Error("database result unknown"); };
    await expect(f.sdk.run(token, operation(), f.resource)).rejects.toThrow("database result unknown");
    expect(f.events.filter(event => event === "finalize-upload")).toHaveLength(1);
    expect(f.events.at(-1)).toBe("dispose"); expect(f.events).not.toContain("cancel-upload");
  });
});

describe("service-owned captured body permit", () => {
  it("authorizes the streamed digest then executes the same Blob after the latest ACL", async () => {
    const original = new Blob(["private"]), events: string[] = [];
    const op = { action: "media.write", resource: "/api/media/1", requestId, body: original };
    const sdk = new CompositeServiceSessions(async (action, raw) => {
      events.push(action); expect((raw as { contentDigest: string }).contentDigest).toBe(digest("private"));
      op.body = new Blob(["changed"]);
      return action === "authorize" ? { permit: token, expiresIn: 30, risk: "important" } : { allowed: true, requestId, risk: "important" };
    });
    await expect(sdk.runCaptured(session(), op, { risk: "important", maximumBytes: 1024, isCurrent: () => true,
      authorizeResource: () => { events.push("acl"); return true; }, execute: async body => { events.push("execute"); expect(body).toBe(original); return body.text(); } })).resolves.toBe("private");
    expect(events).toEqual(["authorize", "consume", "acl", "execute"]);
  });
});
