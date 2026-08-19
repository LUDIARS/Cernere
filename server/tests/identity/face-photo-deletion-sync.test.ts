/**
 * テンプレート失効経路が写真も一緒に消すことの回帰テスト。
 * 「テンプレートだけ消えて写真が残る」経路をゼロに保つための担保。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-drizzle.js";
import { PgDialect } from "drizzle-orm/pg-core";

const fake = createFakeDb();

vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/identity/face-template-crypto.js", () => ({
  createFaceTemplateDistributor: vi.fn(() => ({ keyId: "facility:test:v1", seal: (b: Buffer) => b })),
  openStoredFaceTemplate: vi.fn(() => Buffer.alloc(4)),
  sealStoredFaceTemplate: vi.fn(() => Buffer.alloc(4)),
}));

const { revokeFaceTemplates, revokeFacilityFaceTemplates } = await import("../../src/identity/face-template-store.js");
const schema = await import("../../src/db/schema.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

describe("face template revocation deletes the photo too", () => {
  beforeEach(() => {
    fake.deletes.length = 0;
    fake.inserts.length = 0;
    (fake.db.execute as ReturnType<typeof vi.fn>).mockClear();
  });

  it("本人撤回でテンプレートと写真の両方を消す", async () => {
    fake.queueSelect([{ id: "row-1", userId: USER_ID, facilityId: FACILITY_ID, version: 2, consentId: "consent-a" }]);
    fake.queueSelect([{ id: "consent-a" }]);
    const result = await revokeFaceTemplates(USER_ID, FACILITY_ID, "user_revoked", true);
    expect(result.removed).toBe(1);
    expect(fake.deletes.map((d) => d.table)).toContain(schema.faceTemplates);
    expect(fake.deletes.map((d) => d.table)).toContain(schema.facePhotos);
  });

  it("テンプレートが 0 件でも写真は消しに行く (写真だけ残さない)", async () => {
    fake.queueSelect([]);
    fake.queueSelect([{ id: "consent-a" }]);
    await revokeFaceTemplates(USER_ID, undefined, "account_deleted", true);
    expect(fake.deletes.map((d) => d.table)).toContain(schema.facePhotos);
  });

  it("施設まるごとの失効でも所属者の写真を消す", async () => {
    fake.queueSelect([{ userId: USER_ID }]);
    fake.queueSelect([{ id: "row-1", userId: USER_ID, facilityId: FACILITY_ID, version: 1, consentId: "consent-a" }]);
    fake.queueSelect([{ id: "consent-a", userId: USER_ID }]);
    await revokeFacilityFaceTemplates(FACILITY_ID, "facility_deleted");
    expect(fake.db.execute).toHaveBeenCalled();
    expect(fake.deletes.map((d) => d.table)).toContain(schema.facePhotos);
  });

  it("施設単位の失効は user 全体ではなく、その施設同意に紐付く写真だけを消す", async () => {
    fake.queueSelect([{
      id: "row-a",
      userId: USER_ID,
      facilityId: FACILITY_ID,
      version: 1,
      consentId: "consent-a",
    }]);
    await revokeFaceTemplates(USER_ID, FACILITY_ID, "service_revoked", false);

    const photoDelete = fake.deletes.find((entry) => entry.table === schema.facePhotos);
    expect(photoDelete).toBeDefined();
    const dialect = new PgDialect();
    const rendered = dialect.sqlToQuery(photoDelete?.conditions[0] as never);
    expect(rendered.sql).toContain("consent_id");
    expect(rendered.params).toContain("consent-a");
  });
});
