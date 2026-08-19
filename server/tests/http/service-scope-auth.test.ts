/** 写真 read scope が DB 上で現在も有効な tool credential に限定されること。 */

import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../identity/fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const { generateProjectToken, generateToolToken } = await import("../../src/auth/jwt.js");
const { requireServiceScope } = await import("../../src/http/service-scope-auth.js");

const TOOL_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

describe("requireServiceScope", () => {
  it("active な tool client の現在の DB scope を確認して owner を actor にする", async () => {
    fake.queueSelect([{
      ownerUserId: OWNER_ID,
      scopes: ["face-photo:read"],
      isActive: true,
    }]);
    const token = generateToolToken(TOOL_ID, OWNER_ID, ["face-photo:read"]);

    await expect(requireServiceScope(`Bearer ${token}`, "face-photo:read"))
      .resolves.toEqual({ kind: "tool", subject: TOOL_ID, actorUserId: OWNER_ID });
  });

  it("token に古い scope が残っていても DB で revoke 済みなら拒否する", async () => {
    fake.queueSelect([{
      ownerUserId: OWNER_ID,
      scopes: [],
      isActive: true,
    }]);
    const token = generateToolToken(TOOL_ID, OWNER_ID, ["face-photo:read"]);

    await expect(requireServiceScope(`Bearer ${token}`, "face-photo:read"))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("scope を発行できない project token は写真 read / manage に流用しない", async () => {
    fake.queueSelect([]);
    const token = generateProjectToken("client-1", "ostiarius");

    await expect(requireServiceScope(`Bearer ${token}`, "face-photo:read"))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(requireServiceScope(`Bearer ${token}`, "face-photo:manage"))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
