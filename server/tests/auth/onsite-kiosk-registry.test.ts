/** kiosk 公開鍵レジストリの入力検証と、 revoked lanId を再登録で戻さないこと。 @implements SPEC-MFA-ONSITE */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/connection.js", () => ({ db: {} }));

const { parseOnsiteKioskInput } = await import("../../src/auth/onsite-kiosk-input.js");
const { registerOnsiteKiosk } = await import("../../src/auth/onsite-kiosk-registry.js");

const ed25519Pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
const input = { lanId: "lan-1", placeId: "place-1", publicKeyPem: ed25519Pem, lanUrl: "https://kiosk.lan:8443/", label: "1F" };

/** insert().values().onConflictDoUpdate().returning() だけを再現する。 */
function fakeDb(existingStatus: "active" | "revoked" | null) {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            if (existingStatus === "revoked") return [];
            return [existingStatus === "active" ? { ...row, ...set, status: "active" } : row];
          },
        }),
      }),
    }),
  } as never;
}

describe("parseOnsiteKioskInput", () => {
  it("normalizes an Ed25519 SPKI PEM and an https LAN URL", () => {
    const parsed = parseOnsiteKioskInput(input);
    expect(parsed).toMatchObject({ lanId: "lan-1", placeId: "place-1", lanUrl: "https://kiosk.lan:8443", label: "1F" });
    expect(parsed.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it.each([
    ["an RSA key", { publicKeyPem: rsaPem }],
    ["a non-PEM key", { publicKeyPem: "not a key" }],
    ["an http URL", { lanUrl: "http://kiosk.lan" }],
    ["a URL with credentials", { lanUrl: "https://user:pw@kiosk.lan" }],
    ["an unknown field", { selfRegistered: true }],
    ["a malformed lanId", { lanId: "lan 1" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseOnsiteKioskInput({ ...input, ...override })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("registerOnsiteKiosk", () => {
  it("registers and updates an active kiosk", async () => {
    const parsed = parseOnsiteKioskInput(input);
    await expect(registerOnsiteKiosk(parsed, new Date(), fakeDb(null))).resolves.toMatchObject({ lanId: "lan-1", status: "active" });
    await expect(registerOnsiteKiosk(parsed, new Date(), fakeDb("active"))).resolves.toMatchObject({ lanId: "lan-1", status: "active" });
  });

  it("refuses to bring a revoked lanId back to active", async () => {
    await expect(registerOnsiteKiosk(parseOnsiteKioskInput(input), new Date(), fakeDb("revoked")))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
