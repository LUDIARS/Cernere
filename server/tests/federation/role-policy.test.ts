/** 有効な role = 連携していれば主の role、していなければ自分の role (account-federation §3.1)。 */
import { describe, expect, it } from "vitest";

import { pickEffectiveRole } from "../../src/federation/role-policy.js";

const PHONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("pickEffectiveRole", () => {
  it("主が admin なら、後から連携した general のアカウントも admin", () => {
    expect(pickEffectiveRole(PC, "general", { primaryUserId: PHONE, role: "admin", accessStatus: "active" })).toBe("admin");
  });

  it("主が general なら、連携した admin のアカウントも general (主に揃える)", () => {
    expect(pickEffectiveRole(PC, "admin", { primaryUserId: PHONE, role: "general", accessStatus: "active" })).toBe("general");
  });

  it("連携していなければ自分の role (連携を外れた後も自分の role に戻る)", () => {
    expect(pickEffectiveRole(PC, "general", null)).toBe("general");
  });

  it("自分が主なら自分の role", () => {
    expect(pickEffectiveRole(PHONE, "admin", { primaryUserId: PHONE, role: "admin", accessStatus: "active" })).toBe("admin");
  });

  it.each(["locked", "pending", null])("主が active でない (%s) なら主の role を引き継がない", (accessStatus) => {
    expect(pickEffectiveRole(PC, "general", { primaryUserId: PHONE, role: "admin", accessStatus })).toBe("general");
  });

  it("主の行が無ければ自分の role", () => {
    expect(pickEffectiveRole(PC, "general", { primaryUserId: PHONE, role: null, accessStatus: null })).toBe("general");
  });
});
