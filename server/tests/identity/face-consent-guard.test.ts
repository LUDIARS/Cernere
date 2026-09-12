/**
 * 同意版と職員ロールの判定。
 *
 * 顔データの正本は施設 kiosk (Ostiarius) にあるので、guard が見るのは
 * 「現行版で同意しているか」「誰が撤回を指示できるか」だけ。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const {
  CURRENT_POLICY_VERSION,
  LOCAL_ACCEPTED_VERSIONS,
  isAcceptableNewConsentVersion,
  isConsentFresh,
  isKnownPolicyVersion,
  requireFaceReviewer,
  requireFacilityMembership,
} = await import("../../src/identity/face-consent-guard.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

describe("face consent policy versions", () => {
  it("現行版は施設ローカル保存版のみ", () => {
    expect(CURRENT_POLICY_VERSION).toBe("face-local-v1");
    expect(LOCAL_ACCEPTED_VERSIONS).toEqual(["face-local-v1"]);
  });

  it("旧版は既存行の読み取りのためだけに既知として残す", () => {
    expect(isKnownPolicyVersion("face-template-v1")).toBe(true);
    expect(isKnownPolicyVersion("face-photo-v1")).toBe(true);
    expect(isKnownPolicyVersion("unknown-policy")).toBe(false);
  });

  it("新規同意は現行版しか受理しない (旧版の同意者には再同意を求める)", () => {
    expect(isAcceptableNewConsentVersion("face-local-v1")).toBe(true);
    expect(isAcceptableNewConsentVersion("face-photo-v1")).toBe(false);
    expect(isAcceptableNewConsentVersion("face-template-v1")).toBe(false);
  });

  it("365 日を超えた同意は fresh ではない", () => {
    expect(isConsentFresh(new Date())).toBe(true);
    expect(isConsentFresh(new Date(Date.now() - 400 * 86400000))).toBe(false);
  });
});

describe("requireFacilityMembership", () => {
  beforeEach(() => { fake.selects.length = 0; });

  it("所属していない施設の同意は 403", async () => {
    fake.queueSelect([]);
    await expect(requireFacilityMembership(USER_ID, FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("在籍していれば通る", async () => {
    fake.queueSelect([{ userId: USER_ID }]);
    await expect(requireFacilityMembership(USER_ID, FACILITY_ID)).resolves.toBeUndefined();
  });
});

describe("requireFaceReviewer", () => {
  beforeEach(() => { fake.selects.length = 0; });

  it("一般 member に撤回の指示権限を与えない", async () => {
    fake.queueSelect([{ role: "member" }]);
    await expect(requireFaceReviewer(USER_ID, FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("施設 maintainer は撤回を指示できる", async () => {
    fake.queueSelect([{ role: "maintainer" }]);
    await expect(requireFaceReviewer(USER_ID, FACILITY_ID)).resolves.toBeUndefined();
  });
});
