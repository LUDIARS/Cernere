/**
 * 失効指示の積み上げ・配布・30 日回収。
 *
 * ここで守りたいのは 3 点:
 *   - 失効指示に生体情報が入らない (列が userId / facilityId / reason / at だけ)
 *   - 30 日を超えた指示は回収される
 *   - since が保持期間より前を指しても、回収済み期間を「削除不要」と誤解させない
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const store = await import("../../src/identity/face-revocation-store.js");
const schema = await import("../../src/db/schema.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

function conditionSql(condition: unknown): string {
  const query = new PgDialect().sqlToQuery(condition as never);
  return `${query.sql} :: ${JSON.stringify(query.params)}`;
}

describe("appendFaceRevocations", () => {
  beforeEach(() => {
    fake.inserts.length = 0;
    fake.deletes.length = 0;
    fake.selects.length = 0;
  });

  it("対象ごとに 1 行積み、生体情報を含む列を書かない", async () => {
    const at = new Date("2026-09-12T00:00:00.000Z");
    const appended = await store.appendFaceRevocations(
      fake.db as never,
      [{ userId: USER_ID, facilityId: FACILITY_ID }, { userId: OTHER_USER_ID, facilityId: FACILITY_ID }],
      "left_facility",
      at,
    );

    expect(appended).toBe(2);
    expect(fake.inserts.map((entry) => entry.table)).toEqual([
      schema.faceRevocations,
      schema.faceRevocations,
    ]);
    for (const entry of fake.inserts) {
      expect(Object.keys(entry.values as object).sort())
        .toEqual(["at", "facilityId", "id", "reason", "userId"]);
    }
  });

  it("同じ user / facility を重複して渡しても 1 行にまとめる", async () => {
    const appended = await store.appendFaceRevocations(
      fake.db as never,
      [{ userId: USER_ID, facilityId: FACILITY_ID }, { userId: USER_ID, facilityId: FACILITY_ID }],
      "withdrawn",
    );

    expect(appended).toBe(1);
    expect(fake.inserts).toHaveLength(1);
  });

  it("userId / facilityId が欠けた対象は積まない", async () => {
    const appended = await store.appendFaceRevocations(
      fake.db as never,
      [{ userId: "", facilityId: FACILITY_ID }, { userId: USER_ID, facilityId: "" }],
      "withdrawn",
    );

    expect(appended).toBe(0);
    expect(fake.inserts).toHaveLength(0);
  });
});

describe("listFaceRevocations", () => {
  beforeEach(() => {
    fake.inserts.length = 0;
    fake.deletes.length = 0;
    fake.selects.length = 0;
  });

  it("配布前に 30 日を超えた指示を回収する", async () => {
    fake.queueSelect([]);
    await store.listFaceRevocations(FACILITY_ID);

    expect(fake.deletes.map((entry) => entry.table)).toContain(schema.faceRevocations);
    const purge = fake.deletes.find((entry) => entry.table === schema.faceRevocations);
    const cutoff = conditionSql(purge?.conditions[0]);
    // 30 日境界の日時が cutoff として渡っている (= 回収されるのは保持期間外だけ)。
    const [isoParam] = JSON.parse(cutoff.split(" :: ")[1]) as string[];
    const days = (Date.now() - new Date(isoParam).getTime()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("since が保持期間より前なら 30 日境界まで切り上げる", async () => {
    fake.queueSelect([]);
    await store.listFaceRevocations(FACILITY_ID, new Date("2020-01-01T00:00:00.000Z"));

    const listSelect = fake.selects[fake.selects.length - 1];
    const params = JSON.parse(conditionSql(listSelect.conditions[0]).split(" :: ")[1]) as string[];
    const since = params.map((value) => new Date(value)).find((value) => !Number.isNaN(value.getTime()));
    expect(since).toBeDefined();
    expect(since!.getTime()).toBeGreaterThan(Date.now() - 31 * 86400000);
  });

  it("保持期間内の since はそのまま使う", async () => {
    const since = new Date(Date.now() - 3 * 86400000);
    fake.queueSelect([]);
    await store.listFaceRevocations(FACILITY_ID, since);

    const listSelect = fake.selects[fake.selects.length - 1];
    expect(conditionSql(listSelect.conditions[0])).toContain(since.toISOString());
  });

  it("返す行は userId / facilityId / reason / at だけ", async () => {
    const at = new Date("2026-09-10T01:02:03.000Z");
    // 回収は delete だけで select を挟まないので、最初の select が配布対象になる。
    fake.queueSelect([{ userId: USER_ID, facilityId: FACILITY_ID, reason: "withdrawn", at }]);

    const rows = await store.listFaceRevocations(FACILITY_ID);

    expect(rows).toEqual([{
      userId: USER_ID,
      facilityId: FACILITY_ID,
      reason: "withdrawn",
      at: at.toISOString(),
    }]);
  });
});

describe("isFaceRevocationReason", () => {
  it("契約に無い理由を通さない", () => {
    expect(store.FACE_REVOCATION_REASONS).toEqual([
      "withdrawn",
      "left_facility",
      "graduated",
      "account_deleted",
      "consent_expired",
      "staff_invalidated",
    ]);
    expect(store.isFaceRevocationReason("withdrawn")).toBe(true);
    expect(store.isFaceRevocationReason("staff_invalidated")).toBe(true);
    expect(store.isFaceRevocationReason("membership_removed")).toBe(false);
  });

  it("保持期間は 30 日", () => {
    expect(store.REVOCATION_RETENTION_DAYS).toBe(30);
  });
});
