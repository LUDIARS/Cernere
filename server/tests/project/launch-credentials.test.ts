import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { createLaunchCredentialMaterial } from "../../src/project/launch-credentials.js";

describe("launch credential material", () => {
  it("creates only a one-way bcrypt verifier", async () => {
    const clientSecret = "ex-generated-launch-secret-0123456789abcdef";
    const material = await createLaunchCredentialMaterial(clientSecret);

    expect("clientSecretEncrypted" in material).toBe(false);
    await expect(bcrypt.compare(clientSecret, material.clientSecretHash)).resolves.toBe(true);
  });
});
