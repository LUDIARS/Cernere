/**
 * 同意版の経路分離テスト。
 *
 * face-template-v1 の同意しか無い生徒は:
 *   - 写真アップロード -> 409 consent_required (写真を保存しないと書いた同意なので)
 *   - テンプレート経路 -> 従来どおり通る (版上げで出席照合を止めない)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const guard = await import("../../src/identity/face-consent-guard.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

function lastConditionSql(): string {
  const dialect = new PgDialect();
  const conditions = fake.selects.flatMap((select) => select.conditions);
  const query = dialect.sqlToQuery(conditions[conditions.length - 1] as never);
  return `${query.sql} :: ${JSON.stringify(query.params)}`;
}

describe("face consent policy version routing", () => {
  beforeEach(() => { fake.selects.length = 0; });

  it("写真経路は face-photo-v1 のみを受け付ける", () => {
    expect(guard.PHOTO_ACCEPTED_VERSIONS).toEqual(["face-photo-v1"]);
  });

  it("テンプレート経路は face-template-v1 と face-photo-v1 の両方を受け付ける", () => {
    expect(guard.TEMPLATE_ACCEPTED_VERSIONS).toEqual(["face-template-v1", "face-photo-v1"]);
  });

  it("face-template-v1 の同意しか無ければ写真経路は 409 consent_required", async () => {
    // 写真版の同意が無い = 該当行なし。
    fake.queueSelect([]);
    await expect(guard.requireActiveConsent(USER_ID, FACILITY_ID, { versions: guard.PHOTO_ACCEPTED_VERSIONS }))
      .rejects.toMatchObject({ statusCode: 409, message: "consent_required" });
    expect(lastConditionSql()).toContain('"face-photo-v1"');
    expect(lastConditionSql()).not.toContain('"face-template-v1"');
  });

  it("同じ生徒でもテンプレート経路は face-template-v1 の同意で通る", async () => {
    fake.queueSelect([{ id: "consent-template", at: new Date() }]);
    await expect(guard.requireActiveConsent(USER_ID, FACILITY_ID))
      .resolves.toMatchObject({ id: "consent-template" });
    expect(lastConditionSql()).toContain('"face-template-v1"');
  });
});

describe("face consent policy payload", () => {
  it("policy API は全版を版名・文面付きで返し、写真版は保存・表示範囲・削除を明記する", async () => {
    const { faceConsentPolicy } = await import("../../src/identity/face-template-store.js");
    expect(faceConsentPolicy.version).toBe("face-photo-v1");
    expect(faceConsentPolicy.policies.map((policy) => policy.version))
      .toEqual(["face-template-v1", "face-photo-v1"]);
    const photo = faceConsentPolicy.policies.find((policy) => policy.version === "face-photo-v1");
    expect(photo?.text).toContain("暗号化して保存");
    expect(photo?.text).toContain("kiosk");
    expect(photo?.text).toContain("同時に削除");
    expect(photo?.requiredFor).toContain("face-photo");
  });

  it("未知の版を指定した同意は拒否する", async () => {
    const { createFaceConsent } = await import("../../src/identity/face-template-store.js");
    await expect(createFaceConsent(USER_ID, "unknown-policy", FACILITY_ID))
      .rejects.toMatchObject({ statusCode: 409, message: "current_policy_consent_required" });
  });

  it("写真版から template-only 版へ切り替えると旧同意の写真を削除する", async () => {
    const { createFaceConsent } = await import("../../src/identity/face-template-store.js");
    const schema = await import("../../src/db/schema.js");
    fake.deletes.length = 0;
    fake.queueSelect([{ userId: USER_ID }]);
    fake.queueSelect([{ userId: USER_ID }]);
    fake.queueSelect([{ id: "photo-consent", policyVersion: "face-photo-v1" }]);

    await createFaceConsent(USER_ID, "face-template-v1", FACILITY_ID);

    expect(fake.deletes.map((entry) => entry.table)).toContain(schema.facePhotos);
  });
});
