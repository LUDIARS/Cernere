import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetKeyCacheForTest, decryptSecret } from "../../src/lib/crypto/secret-box.js";
import { createLaunchCredentialMaterial } from "../../src/project/launch-credentials.js";

describe("launch credential material", () => {
  const previousKey = process.env.CERNERE_SECRET_KEY;

  beforeEach(() => {
    process.env.CERNERE_SECRET_KEY = "0123456789abcdef0123456789abcdef";
    _resetKeyCacheForTest();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.CERNERE_SECRET_KEY;
    else process.env.CERNERE_SECRET_KEY = previousKey;
    _resetKeyCacheForTest();
  });

  it("creates a bcrypt login hash and a reversible AES-GCM persistence record", async () => {
    const clientSecret = "ex-generated-launch-secret-0123456789abcdef";
    const material = await createLaunchCredentialMaterial(clientSecret);

    expect(material.clientSecretEncrypted).toMatch(/^v1:/);
    expect(material.clientSecretEncrypted).not.toContain(clientSecret);
    await expect(bcrypt.compare(clientSecret, material.clientSecretHash)).resolves.toBe(true);
    expect(decryptSecret(material.clientSecretEncrypted)).toBe(clientSecret);
  });
});
