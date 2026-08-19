/** consent_id を AAD に含む写真の再同意回帰テスト。 */

import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();
const mocks = vi.hoisted(() => ({
  open: vi.fn((_sealed: unknown, _context: unknown) => Buffer.from("normalized-photo")),
  seal: vi.fn((_bytes: Buffer, _context: unknown) => ({
    ciphertext: Buffer.from("resealed"),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
    keyId: "photo-storage:v1",
  })),
}));

vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/identity/face-photo-crypto.js", () => ({
  openFacePhoto: mocks.open,
  sealFacePhoto: mocks.seal,
}));

const { rebindFacePhotoConsent } = await import("../../src/identity/face-photo-consent.js");

describe("rebindFacePhotoConsent", () => {
  it("旧 consentId で開封し、新 consentId の AAD で再封緘して更新する", async () => {
    fake.queueSelect([{
      id: "photo-1",
      userId: "11111111-1111-4111-8111-111111111111",
      consentId: "consent-old",
      ciphertext: Buffer.from("sealed"),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
      keyId: "photo-storage:v1",
      mime: "image/jpeg",
    }]);

    await rebindFacePhotoConsent(
      fake.db as never,
      "11111111-1111-4111-8111-111111111111",
      ["consent-old"],
      "consent-new",
    );

    expect(mocks.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ consentId: "consent-old" }),
    );
    expect(mocks.seal).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ consentId: "consent-new" }),
    );
    expect(fake.updates.at(-1)?.values).toMatchObject({ consentId: "consent-new" });
    expect(mocks.seal.mock.calls[0][0].every((byte: number) => byte === 0)).toBe(true);
  });
});
