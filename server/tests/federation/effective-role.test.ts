/**
 * 有効な role の読み出し (account-federation §3.1)。
 * DB は FIFO のモック: 自分の行 → 連携の主 → 主の行 の順に引く。SQL の意味論は再現しない。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb } from "../identity/fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const schema = await import("../../src/db/schema.js");
const { isEffectiveAdmin, loadEffectiveRole, resolveEffectiveRole } = await import("../../src/federation/effective-role.js");

const PHONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TABLET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  fake.selects.length = 0;
});

describe("loadEffectiveRole / isEffectiveAdmin", () => {
  it("主 (スマホ) が admin なら、後から連携した PC (general) も admin", async () => {
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([{ primaryUserId: PHONE }]);
    fake.queueSelect([{ role: "admin", accessStatus: "active" }]);
    expect(await loadEffectiveRole(PC)).toBe("admin");
    expect(fake.selects.map((query) => query.table)).toEqual([schema.users, schema.accountFederationMembers, schema.users]);
  });

  it("system admin の判定も主の role で決まる", async () => {
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([{ primaryUserId: PHONE }]);
    fake.queueSelect([{ role: "admin", accessStatus: "active" }]);
    expect(await isEffectiveAdmin(PC)).toBe(true);
  });

  it("連携していなければ自分の role (連携解除後もここに戻る)", async () => {
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([]);
    expect(await loadEffectiveRole(PC)).toBe("general");
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([]);
    expect(await isEffectiveAdmin(PC)).toBe(false);
  });

  it("主を切り替えたら新しい主の role に従う", async () => {
    // スマホ (admin) からタブレット (general) へ主を切り替えた後の PC。
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([{ primaryUserId: TABLET }]);
    fake.queueSelect([{ role: "general", accessStatus: "active" }]);
    expect(await loadEffectiveRole(PC)).toBe("general");
  });

  it("自分が主なら主の行を引き直さない", async () => {
    fake.queueSelect([{ role: "admin" }]);
    fake.queueSelect([{ primaryUserId: PHONE }]);
    expect(await loadEffectiveRole(PHONE)).toBe("admin");
    expect(fake.selects).toHaveLength(2);
  });

  it("主が locked なら主の admin を引き継がない", async () => {
    fake.queueSelect([{ role: "general" }]);
    fake.queueSelect([{ primaryUserId: PHONE }]);
    fake.queueSelect([{ role: "admin", accessStatus: "locked" }]);
    expect(await isEffectiveAdmin(PC)).toBe(false);
  });

  it("アカウントが無ければ null", async () => {
    fake.queueSelect([]);
    expect(await loadEffectiveRole(PC)).toBeNull();
  });
});

describe("resolveEffectiveRole", () => {
  it("自分の role を読んである呼び出し側は、連携の主だけを引く", async () => {
    fake.queueSelect([{ primaryUserId: PHONE }]);
    fake.queueSelect([{ role: "admin", accessStatus: "active" }]);
    expect(await resolveEffectiveRole(PC, "general")).toBe("admin");
    expect(fake.selects.map((query) => query.table)).toEqual([schema.accountFederationMembers, schema.users]);
  });
});
