import { beforeEach, expect, it, vi } from "vitest";

const resolve = vi.fn();
const evaluate = vi.fn();
const denials = vi.fn();
vi.mock("../../src/consent/project-resolver.js", () => ({ resolveProjectSubject: resolve }));
vi.mock("../../src/consent/gate.js", () => ({ evaluateForUser: evaluate }));
vi.mock("../../src/consent/denials.js", () => ({ deniedPermissionKeys: denials }));
const { getProjectUserPermissions } = await import("../../src/project/user-permissions.js");

beforeEach(() => {
  resolve.mockResolvedValue({ subject: { kind: "project", key: "test" } });
  evaluate.mockResolvedValue({ satisfied: true, view: { declared: true, required: [],
    recommended: [{ key: "user_data.module:presence", decision: "granted", purpose: "Availability" }] } });
  denials.mockResolvedValue(new Set());
});

it("respects a later opt-out even when the recorded consent is granted", async () => {
  denials.mockResolvedValue(new Set(["user_data.module:presence"]));
  expect((await getProjectUserPermissions("test", "self")).permissions[0]?.allowed).toBe(false);
  expect(denials).toHaveBeenCalledWith("self", "test");
});

it("allows granted permissions and fails closed for revoked service access", async () => {
  expect((await getProjectUserPermissions("test", "self")).permissions[0]?.allowed).toBe(true);
  evaluate.mockResolvedValue({ satisfied: false, view: { declared: true, required: [],
    recommended: [{ key: "user_data.module:presence", decision: "granted", purpose: null }] } });
  expect((await getProjectUserPermissions("test", "self")).permissions[0]?.allowed).toBe(false);
});

it("does not return permission data for an unavailable project", async () => {
  resolve.mockResolvedValue(null);
  await expect(getProjectUserPermissions("missing", "self")).rejects.toThrow("Project not found");
});

it("reports an explicit opt-out as denied so the service can tell it apart from an undecided permission", async () => {
  denials.mockResolvedValue(new Set(["user_data.module:presence"]));
  const denied = await getProjectUserPermissions("test", "self");
  expect(denied.permissions[0]).toMatchObject({ allowed: false, state: "denied" });
  expect(denied.optedOutModules).toEqual(["presence"]);

  denials.mockResolvedValue(new Set());
  evaluate.mockResolvedValue({ satisfied: false, view: { declared: true, required: [],
    recommended: [{ key: "user_data.module:presence", decision: "pending", purpose: null }] } });
  const undecided = await getProjectUserPermissions("test", "self");
  expect(undecided.permissions[0]).toMatchObject({ allowed: false, state: "undecided" });
  expect(undecided.optedOutModules).toEqual([]);
});

it("lists opted-out modules that are not declared as consent permissions, without other categories", async () => {
  denials.mockResolvedValue(new Set(["user_data.module:profile", "profile.email", "user_data.module:career"]));
  const result = await getProjectUserPermissions("test", "self");
  expect(result.permissions[0]).toMatchObject({ allowed: true, state: "granted" });
  expect(result.optedOutModules).toEqual(["career", "profile"]);
});
