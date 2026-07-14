import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { issueProjectSecret } from "../../src/project/credentials.js";

describe("issueProjectSecret", () => {
  it("returns a one-time plaintext UUID and only a bcrypt hash for persistence", async () => {
    const issued = await issueProjectSecret();

    expect(issued.clientSecret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(issued.clientSecretHash).not.toContain(issued.clientSecret);
    await expect(bcrypt.compare(issued.clientSecret, issued.clientSecretHash)).resolves.toBe(true);
  });
});
