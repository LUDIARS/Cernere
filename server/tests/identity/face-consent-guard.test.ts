/**
 * 同意チェックの回帰テスト。
 * 旧 policyVersion しか無い / 365 日再同意なし は 409 consent_required。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const { requireActiveConsent, requireFaceReviewer } = await import("../../src/identity/face-consent-guard.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

describe("requireActiveConsent", () => {
  beforeEach(() => { fake.selects.length = 0; });

  it("現行 policyVersion の同意が無ければ 409 consent_required", async () => {
    fake.queueSelect([]);
    await expect(requireActiveConsent(USER_ID, FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 409, message: "consent_required" });
  });

  it("365 日を超えて再同意が無い場合も 409", async () => {
    fake.queueSelect([{ id: "consent-1", at: new Date(Date.now() - 400 * 86400000) }]);
    await expect(requireActiveConsent(USER_ID, FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("有効な同意なら consentId を返す", async () => {
    fake.queueSelect([{ id: "consent-1", at: new Date() }]);
    await expect(requireActiveConsent(USER_ID, FACILITY_ID)).resolves.toMatchObject({ id: "consent-1" });
  });
});

describe("requireFaceReviewer", () => {
  beforeEach(() => { fake.selects.length = 0; });

  it("一般 member を顔テンプレート審査者として扱わない", async () => {
    fake.queueSelect([{ role: "member" }]);
    await expect(requireFaceReviewer(USER_ID, FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("施設 maintainer は審査できる", async () => {
    fake.queueSelect([{ role: "maintainer" }]);
    await expect(requireFaceReviewer(USER_ID, FACILITY_ID)).resolves.toBeUndefined();
  });
});
