/**
 * 写真保存経路の境界テスト。
 *
 * - 鍵 / sidecar 未設定は 503 (fail closed)
 * - 顔が取れない画像は 422 で、DB へは一切書かない
 * - 写真削除はテンプレート削除と同一 transaction で起き、tombstone を残す
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
const mocks = vi.hoisted(() => ({
  keyConfigured: true,
  sidecarConfigured: true,
  extract: vi.fn(),
  requireActiveConsent: vi.fn(),
  requireFacilityMembership: vi.fn(),
}));

vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/identity/face-photo-crypto.js", () => ({
  isFacePhotoKeyConfigured: () => mocks.keyConfigured,
  facePhotoKeyId: () => "photo-storage:v1",
  sealFacePhoto: () => ({ ciphertext: Buffer.alloc(8), iv: Buffer.alloc(12), tag: Buffer.alloc(16), keyId: "photo-storage:v1" }),
  openFacePhoto: () => Buffer.alloc(8),
}));
vi.mock("../../src/identity/face-photo-image.js", () => ({
  assertAcceptedInputMime: vi.fn(),
  normalizeForStorage: vi.fn(async () => ({ bytes: Buffer.alloc(64), mime: "image/jpeg", width: 1024, height: 768 })),
  shrinkForExtraction: vi.fn(async (b: Buffer) => b),
}));
vi.mock("../../src/identity/face-sidecar-client.js", () => ({
  isFaceSidecarConfigured: () => mocks.sidecarConfigured,
  extractFaceEmbedding: mocks.extract,
}));
vi.mock("../../src/identity/face-consent-guard.js", () => ({
  PHOTO_ACCEPTED_VERSIONS: ["face-photo-v1"],
  RECONSENT_DAYS: 365,
  requireFacilityMembership: mocks.requireFacilityMembership,
  requireFaceReviewer: vi.fn(async () => undefined),
  requireActiveConsent: mocks.requireActiveConsent,
}));
vi.mock("../../src/identity/face-template-versioning.js", () => ({
  lockFaceTemplateVersion: vi.fn(async () => undefined),
  nextFaceTemplateVersion: vi.fn(async () => 1),
}));
vi.mock("../../src/identity/face-template-crypto.js", () => ({
  sealStoredFaceTemplate: vi.fn(() => Buffer.alloc(16)),
}));

const store = await import("../../src/identity/face-photo-store.js");
const schema = await import("../../src/db/schema.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";
const image = () => Buffer.from("fake-image-bytes");

describe("face photo store", () => {
  beforeEach(() => {
    mocks.keyConfigured = true;
    mocks.sidecarConfigured = true;
    mocks.extract.mockReset();
    mocks.requireActiveConsent.mockReset();
    mocks.requireActiveConsent.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      at: new Date(),
    });
    mocks.requireFacilityMembership.mockReset();
    mocks.requireFacilityMembership.mockResolvedValue(undefined);
    fake.deletes.length = 0;
    fake.inserts.length = 0;
    fake.updates.length = 0;
    fake.selects.length = 0;
    (fake.db.transaction as ReturnType<typeof vi.fn>).mockClear();
  });

  it("写真鍵が未設定なら 503 で fail closed する", async () => {
    mocks.keyConfigured = false;
    await expect(store.saveFacePhoto({ userId: USER_ID, facilityId: FACILITY_ID, image: image(), mime: "image/jpeg" }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(fake.db.transaction).not.toHaveBeenCalled();
  });

  it("sidecar が未設定なら 503 で fail closed する", async () => {
    mocks.sidecarConfigured = false;
    await expect(store.saveFacePhoto({ userId: USER_ID, facilityId: FACILITY_ID, image: image(), mime: "image/jpeg" }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(fake.db.transaction).not.toHaveBeenCalled();
  });

  it("顔が検出できない画像は 422 で、写真もテンプレートも保存しない", async () => {
    mocks.extract.mockRejectedValue(Object.assign(new Error("no_face_detected"), { statusCode: 422 }));
    await expect(store.saveFacePhoto({ userId: USER_ID, facilityId: FACILITY_ID, image: image(), mime: "image/jpeg" }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(fake.db.transaction).not.toHaveBeenCalled();
    expect(fake.inserts).toHaveLength(0);
  });

  it("抽出中に同意が撤回されたら lock 後の再検証で保存しない", async () => {
    mocks.extract.mockResolvedValue({
      embedding: Buffer.alloc(512 * Float32Array.BYTES_PER_ELEMENT, 1),
      quality: 90,
      modelId: "test-model",
    });
    mocks.requireActiveConsent
      .mockResolvedValueOnce({ id: "old-consent", at: new Date() })
      .mockRejectedValueOnce(Object.assign(new Error("consent_required"), { statusCode: 409 }));

    await expect(store.saveFacePhoto({
      userId: USER_ID,
      facilityId: FACILITY_ID,
      image: image(),
      mime: "image/jpeg",
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.requireActiveConsent).toHaveBeenCalledTimes(2);
    expect(mocks.requireActiveConsent).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      FACILITY_ID,
      expect.objectContaining({ client: fake.db }),
    );
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("写真削除はテンプレートも同じ transaction で消し、tombstone を残す", async () => {
    fake.queueSelect([{ id: "row-1", userId: USER_ID, facilityId: FACILITY_ID, version: 3 }]);
    const result = await store.deleteFacePhoto(USER_ID, "user_deleted_photo");
    expect(result.removedTemplates).toBe(1);
    expect(fake.deletes.map((d) => d.table)).toContain(schema.faceTemplates);
    expect(fake.deletes.map((d) => d.table)).toContain(schema.facePhotos);
    expect(fake.inserts.map((i) => i.table)).toContain(schema.faceTemplateTombstones);
  });

  it("写真 read は fresh な face-photo 同意が無ければ返さない", async () => {
    fake.queueSelect([]);
    await expect(store.readFacePhoto(USER_ID)).rejects.toMatchObject({ statusCode: 404 });

    const condition = fake.selects.at(-1)?.conditions.at(-1);
    const rendered = new PgDialect().sqlToQuery(condition as never);
    expect(rendered.sql).toContain("policy_version");
    expect(rendered.sql).toContain("revoked_at");
    expect(rendered.params).toContain("face-photo-v1");
  });
});
