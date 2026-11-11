import { describe, expect, it } from "vitest";
import { NAV_ADMIN, NAV_GENERAL, ORG_MANAGER_ROLES as NAV_MANAGERS, isOrgManagerRole, navRowsFor } from "../../../frontend/src/components/nav-items";
import { ORG_ROLE_OPTIONS, assignableRoleValues, canEditMember, roleRank } from "../../../frontend/src/pages/organizations/org-roles";
import { formatDataValue, registeredServices, type UserProjectOverview } from "../../../frontend/src/pages/services/registered-services";
import { ORG_MANAGER_ROLES, ORG_ROLES, assignableRoles, decideRoleChange } from "../../src/org/role-policy.js";

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe("Cernere menu split (general / leader / admin)", () => {
  it("gives general users only their own data, data settings and devices", () => {
    const rows = navRowsFor({ isAdmin: false, isOrgManager: false });
    expect(labels(rows.general)).toEqual(["データを登録しているサービス", "自分のデータ", "データの設定", "端末とログイン"]);
    expect(rows.admin).toEqual([]);
  });

  it("adds 組織 only for leaders and above", () => {
    expect(labels(navRowsFor({ isAdmin: false, isOrgManager: true }).general)).toContain("組織");
    expect(isOrgManagerRole("leader")).toBe(true);
    expect(isOrgManagerRole("member")).toBe(false);
    expect(isOrgManagerRole(undefined)).toBe(false);
  });

  it("shows admins two rows and keeps 利用許可 out of every menu", () => {
    const rows = navRowsFor({ isAdmin: true, isOrgManager: true });
    expect(rows.general).toEqual(NAV_GENERAL);
    expect(rows.admin).toEqual(NAV_ADMIN);
    expect(labels(rows.admin)).toContain("サービス管理");
    const all = [...NAV_GENERAL, ...NAV_ADMIN, ...navRowsFor({ isAdmin: false, isOrgManager: true }).general];
    expect(all.some((i) => i.path === "/access" || i.label === "利用許可")).toBe(false);
  });
});

describe("frontend org roles mirror the server policy", () => {
  it("uses the same role set and manager set", () => {
    expect(ORG_ROLE_OPTIONS.map((o) => o.value)).toEqual([...ORG_ROLES]);
    expect([...NAV_MANAGERS].sort()).toEqual([...ORG_MANAGER_ROLES].sort());
  });

  it("offers the same assignable roles as the server allows", () => {
    for (const actor of ["system_admin", ...ORG_ROLES]) {
      expect(assignableRoleValues(actor)).toEqual(assignableRoles(actor));
    }
  });

  it("only lets a leader edit members and leaders, never themselves", () => {
    expect(canEditMember("leader", "member", false)).toBe(true);
    expect(canEditMember("leader", "admin", false)).toBe(false);
    expect(canEditMember("leader", "member", true)).toBe(false);
    for (const target of ORG_ROLES) {
      expect(canEditMember("leader", target, false)).toBe(decideRoleChange("leader", target, "member").ok);
    }
    expect(roleRank("owner")).toBeGreaterThan(roleRank("admin"));
  });
});

describe("registered services view", () => {
  const ov = (key: string, name: string, inUse: boolean): UserProjectOverview => ({
    key, name, description: "", isActive: true, totalColumns: 3, filledColumns: inUse ? 1 : 0, inUse, connectionCount: 0, lastConnectedAt: null,
  });

  it("lists only services that hold the user's data, sorted by name", () => {
    expect(registeredServices([ov("b", "Bibliotheca", true), ov("g", "GLab", false), ov("a", "Actio", true)]).map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("formats stored values without hiding empties", () => {
    expect(formatDataValue("")).toBe("(未登録)");
    expect(formatDataValue(null)).toBe("(未登録)");
    expect(formatDataValue(3)).toBe("3");
    expect(formatDataValue({ a: 1 })).toBe('{"a":1}');
  });
});
