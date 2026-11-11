import { describe, expect, it } from "vitest";
import {
  assignableRoles, canManageOrg, decideAdd, decideRemove, decideRoleChange, isOrgRole,
} from "../../src/org/role-policy.js";

describe("organization role policy", () => {
  it("lets leaders and above manage the organization, but not plain members", () => {
    for (const role of ["owner", "admin", "maintainer", "leader", "system_admin"]) expect(canManageOrg(role)).toBe(true);
    expect(canManageOrg("member")).toBe(false);
    expect(canManageOrg("unknown")).toBe(false);
  });

  it("limits leaders to member and leader", () => {
    expect(assignableRoles("leader")).toEqual(["leader", "member"]);
    expect(decideAdd("leader", "member").ok).toBe(true);
    expect(decideAdd("leader", "leader").ok).toBe(true);
    for (const role of ["owner", "admin", "maintainer"]) expect(decideAdd("leader", role).ok).toBe(false);
    expect(decideRoleChange("leader", "member", "leader").ok).toBe(true);
    expect(decideRoleChange("leader", "leader", "member").ok).toBe(true);
  });

  it("does not let a leader touch members ranked above them", () => {
    for (const target of ["owner", "admin", "maintainer"]) {
      expect(decideRoleChange("leader", target, "member").ok).toBe(false);
      expect(decideRemove("leader", target).ok).toBe(false);
    }
    expect(decideRemove("leader", "member").ok).toBe(true);
    expect(decideRemove("leader", "leader").ok).toBe(true);
  });

  it("closes the hole where maintainer/admin could grant owner", () => {
    expect(decideAdd("maintainer", "owner").ok).toBe(false);
    expect(decideAdd("admin", "owner").ok).toBe(false);
    expect(decideRoleChange("maintainer", "member", "owner").ok).toBe(false);
    expect(decideRoleChange("admin", "owner", "member").ok).toBe(false);
    expect(decideRemove("admin", "owner").ok).toBe(false);
    expect(decideAdd("admin", "leader").ok).toBe(true);
  });

  it("lets owner and system admin appoint any role, including the first leader", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "maintainer", "leader", "member"]);
    expect(decideRoleChange("system_admin", "member", "leader").ok).toBe(true);
    expect(decideRoleChange("owner", "member", "leader").ok).toBe(true);
  });

  it("rejects members and unknown roles", () => {
    expect(decideAdd("member", "member").ok).toBe(false);
    expect(decideRemove("member", "member").ok).toBe(false);
    expect(decideAdd("owner", "superuser")).toEqual({ ok: false, reason: "Unknown organization role: superuser" });
    expect(isOrgRole("leader")).toBe(true);
    expect(isOrgRole("system_admin")).toBe(false);
  });
});
