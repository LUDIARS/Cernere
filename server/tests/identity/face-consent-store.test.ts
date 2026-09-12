/**
 * 同意記録と失効指示の連動。
 *
 * Cernere はテンプレート・写真を持たないので、撤回の唯一の効果は
 * 「同意に revokedAt を打つ」+「失効指示を積む」であること。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const store = await import("../../src/identity/face-consent-store.js");
const schema = await import("../../src/db/schema.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_FACILITY_ID = "33333333-3333-4333-8333-333333333333";

function reset(): void {
  fake.selects.length = 0;
  fake.inserts.length = 0;
  fake.updates.length = 0;
  fake.deletes.length = 0;
}

describe("faceConsentPolicy", () => {
  it("現行版は face-local-v1 で、施設外へ出さないことを明記する", () => {
    expect(store.faceConsentPolicy.version).toBe("face-local-v1");
    const current = store.faceConsentPolicies.find((policy) => policy.version === "face-local-v1");
    expect(current?.text).toContain("施設の受付端末");
    expect(current?.text).toContain("施設外");
    expect(current?.text).toContain("職員画面");
    expect(current?.deprecated).toBe(false);
  });

  it("旧版は文面を残すが、もう提示しない版として扱う", () => {
    expect(store.faceConsentPolicy.policies.map((policy) => policy.version))
      .toEqual(["face-template-v1", "face-photo-v1", "face-local-v1"]);
    for (const version of ["face-template-v1", "face-photo-v1"]) {
      const old = store.faceConsentPolicies.find((policy) => policy.version === version);
      expect(old?.deprecated).toBe(true);
      expect(old?.requiredFor).toEqual([]);
    }
  });
});

describe("createFaceConsent", () => {
  beforeEach(reset);

  it("旧版での新規同意は 409 current_policy_consent_required", async () => {
    await expect(store.createFaceConsent(USER_ID, "face-photo-v1", FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 409, message: "current_policy_consent_required" });
    expect(store.createFaceConsent(USER_ID, "unknown", FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("現行版の同意は 1 行 insert し、失効指示は積まない", async () => {
    fake.queueSelect([{ userId: USER_ID }]); // requireFacilityMembership (事前)
    fake.queueSelect([{ userId: USER_ID }]); // requireFacilityMembership (tx 内)
    fake.queueSelect([]);                    // 既存の有効な同意なし

    const created = await store.createFaceConsent(USER_ID, "face-local-v1", FACILITY_ID);

    expect(created.consentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.inserts.map((entry) => entry.table)).toEqual([schema.faceConsents]);
    expect(fake.inserts.some((entry) => entry.table === schema.faceRevocations)).toBe(false);
  });

  it("旧版から現行版への切替では旧同意を撤回するだけで失効指示を積まない", async () => {
    fake.queueSelect([{ userId: USER_ID }]);
    fake.queueSelect([{ userId: USER_ID }]);
    fake.queueSelect([{ id: "old-consent", policyVersion: "face-photo-v1" }]);

    await store.createFaceConsent(USER_ID, "face-local-v1", FACILITY_ID);

    expect(fake.updates.map((entry) => entry.table)).toContain(schema.faceConsents);
    expect(fake.inserts.some((entry) => entry.table === schema.faceRevocations)).toBe(false);
  });
});

describe("revokeFaceConsents", () => {
  beforeEach(reset);

  it("撤回は同意に revokedAt を打ち、失効指示 1 行を積む", async () => {
    fake.queueSelect([{ id: "consent-1", facilityId: FACILITY_ID, revokedAt: null }]);

    const result = await store.revokeFaceConsents(USER_ID, FACILITY_ID, "withdrawn");

    expect(result).toMatchObject({ ok: true, revoked: 1, facilities: [FACILITY_ID] });
    expect(fake.updates.map((entry) => entry.table)).toContain(schema.faceConsents);
    const revocation = fake.inserts.find((entry) => entry.table === schema.faceRevocations);
    expect(revocation?.values).toMatchObject({
      userId: USER_ID,
      facilityId: FACILITY_ID,
      reason: "withdrawn",
    });
    // テンプレート・写真のテーブルはもう存在しないので、delete は一切走らない。
    expect(fake.deletes).toHaveLength(0);
  });

  it("同意行が無くても施設が分かっていれば失効指示は積む", async () => {
    fake.queueSelect([]);

    const result = await store.revokeFaceConsents(USER_ID, FACILITY_ID, "staff_invalidated");

    expect(result.revoked).toBe(0);
    expect(fake.inserts.find((entry) => entry.table === schema.faceRevocations)?.values)
      .toMatchObject({ reason: "staff_invalidated", facilityId: FACILITY_ID });
  });

  it("アカウント削除 (施設指定なし) は在籍した施設ごとに 1 行積む", async () => {
    fake.queueSelect([
      { id: "c1", facilityId: FACILITY_ID, revokedAt: null },
      { id: "c2", facilityId: OTHER_FACILITY_ID, revokedAt: new Date() },
    ]);

    const result = await store.revokeFaceConsents(USER_ID, undefined, "account_deleted");

    expect(result.facilities.sort()).toEqual([FACILITY_ID, OTHER_FACILITY_ID].sort());
    const revocations = fake.inserts.filter((entry) => entry.table === schema.faceRevocations);
    expect(revocations).toHaveLength(2);
    // 既に撤回済みの同意でも「消せ」の指示は届かせる。
    expect(revocations.map((entry) => (entry.values as { facilityId: string }).facilityId).sort())
      .toEqual([FACILITY_ID, OTHER_FACILITY_ID].sort());
  });
});

describe("purgeExpiredFaceConsents", () => {
  beforeEach(reset);

  it("365 日再同意が無い同意を撤回し consent_expired を積む", async () => {
    fake.queueSelect([{ id: "c1", userId: USER_ID, facilityId: FACILITY_ID }]);

    const purged = await store.purgeExpiredFaceConsents();

    expect(purged).toBe(1);
    expect(fake.inserts.find((entry) => entry.table === schema.faceRevocations)?.values)
      .toMatchObject({ reason: "consent_expired", userId: USER_ID, facilityId: FACILITY_ID });
  });

  it("期限切れが無ければ何も書かない", async () => {
    fake.queueSelect([]);

    expect(await store.purgeExpiredFaceConsents({ facilityId: FACILITY_ID })).toBe(0);
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });
});

describe("revokeFacilityFaceConsents", () => {
  beforeEach(reset);

  it("施設削除では在籍者ごとに 1 行積む", async () => {
    fake.queueSelect([
      { id: "c1", userId: USER_ID },
      { id: "c2", userId: "55555555-5555-4555-8555-555555555555" },
    ]);

    expect(await store.revokeFacilityFaceConsents(FACILITY_ID, "left_facility")).toBe(2);
    expect(fake.inserts.filter((entry) => entry.table === schema.faceRevocations)).toHaveLength(2);
  });
});
