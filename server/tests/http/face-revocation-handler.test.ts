/**
 * 失効指示 API の認可と入力検証。
 *
 * scope を持たない service token で 403、施設指定なしで 400 になること。
 * 実際の scope 判定は service-scope-auth を通すので、mock ではなく
 * tool token + DB 上の scope で検証する。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../identity/fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const { generateToolToken } = await import("../../src/auth/jwt.js");
const { handleFaceRevocationRoute } = await import("../../src/http/face-revocation-handler.js");

const TOOL_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const FACILITY_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

function toolClient(scopes: string[]) {
  return { ownerUserId: OWNER_ID, scopes, isActive: true };
}

describe("GET /api/identity/face-revocations", () => {
  beforeEach(() => {
    fake.selects.length = 0;
    fake.inserts.length = 0;
    fake.deletes.length = 0;
  });

  it("scope face-revocation:read が無い service token は 403", async () => {
    fake.queueSelect([toolClient([])]);
    const token = generateToolToken(TOOL_ID, OWNER_ID, ["face-revocation:read"]);

    await expect(handleFaceRevocationRoute("GET", `Bearer ${token}`, `facilityId=${FACILITY_ID}`))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("bearer token が無ければ 401", async () => {
    await expect(handleFaceRevocationRoute("GET", "", `facilityId=${FACILITY_ID}`))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("facilityId を指定しない全量取得は 400 (施設外へ配布範囲を広げない)", async () => {
    fake.queueSelect([toolClient(["face-revocation:read"])]);
    const token = generateToolToken(TOOL_ID, OWNER_ID, ["face-revocation:read"]);

    await expect(handleFaceRevocationRoute("GET", `Bearer ${token}`, ""))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("since が ISO 日時でなければ 400", async () => {
    fake.queueSelect([toolClient(["face-revocation:read"])]);
    const token = generateToolToken(TOOL_ID, OWNER_ID, ["face-revocation:read"]);

    await expect(handleFaceRevocationRoute(
      "GET",
      `Bearer ${token}`,
      `facilityId=${FACILITY_ID}&since=yesterday`,
    )).rejects.toMatchObject({ statusCode: 400 });
  });

  it("scope を持つ service token には指示だけを返す (生体情報を含まない)", async () => {
    const at = new Date("2026-09-11T12:00:00.000Z");
    fake.queueSelect([toolClient(["face-revocation:read"])]);
    // 回収は delete だけで select を挟まないので、次の select が配布対象になる。
    fake.queueSelect([{ userId: USER_ID, facilityId: FACILITY_ID, reason: "withdrawn", at }]);

    const result = await handleFaceRevocationRoute(
      "GET",
      `Bearer ${generateToolToken(TOOL_ID, OWNER_ID, ["face-revocation:read"])}`,
      `facilityId=${FACILITY_ID}`,
    );

    expect(result.status).toBe("200 OK");
    const { revocations } = result.data as { revocations: Array<Record<string, unknown>> };
    expect(revocations.length).toBeGreaterThanOrEqual(1);
    for (const row of revocations) {
      expect(Object.keys(row).sort()).toEqual(["at", "facilityId", "reason", "userId"]);
    }
  });

  it("GET 以外は 404", async () => {
    await expect(handleFaceRevocationRoute("POST", "Bearer x", `facilityId=${FACILITY_ID}`))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
