/** service token は client credentials で認証し、sub / aud / scope を登録情報からだけ導出する。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../identity/fake-drizzle.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));

const verifySecret = vi.fn();
vi.mock("../../src/project/credentials.js", () => ({ verifyProjectSecret: verifySecret }));

const signServiceToken = vi.fn(async () => "v4.public.signed");
vi.mock("../../src/auth/service-token.js", () => ({ SERVICE_TOKEN_TTL_SEC: 900, signServiceToken }));

const pasetoEnabled = vi.fn(() => true);
vi.mock("../../src/auth/paseto.js", () => ({ isPasetoEnabled: pasetoEnabled }));

const { issueServiceToken } = await import("../../src/project/service-token-issuer.js");

function project(overrides: Record<string, unknown> = {}) {
  return {
    key: "Volputas", storageSlug: "volputas", clientId: "client-v", clientSecretHash: "hash",
    isActive: true, schemaDefinition: { service_scopes: ["review-relay:write"] }, ...overrides,
  };
}

const target = (overrides: Record<string, unknown> = {}) =>
  project({ key: "EducationLab", storageSlug: "glab", clientId: "client-g", ...overrides });

const request = { clientId: "client-v", clientSecret: "s".repeat(32), targetProjectKey: "EducationLab" };

describe("issueServiceToken", () => {
  beforeEach(() => {
    verifySecret.mockReset().mockResolvedValue(true);
    signServiceToken.mockClear();
    pasetoEnabled.mockReturnValue(true);
  });

  it("呼出元と呼出先の storage_slug を sub / aud に、宣言済み scope を scope に入れる", async () => {
    fake.queueSelect([project()]);
    fake.queueSelect([target()]);

    const issued = await issueServiceToken(request);

    expect(signServiceToken).toHaveBeenCalledWith({
      subject: "volputas", audience: "glab", scopes: ["review-relay:write"],
    });
    expect(issued).toMatchObject({
      tokenType: "service", accessToken: "v4.public.signed", expiresIn: 900,
      subject: "volputas", audience: "glab", scope: ["review-relay:write"],
    });
  });

  it("secret 不一致は 401 で、token を発行しない", async () => {
    fake.queueSelect([project()]);
    verifySecret.mockResolvedValue(false);
    await expect(issueServiceToken(request)).rejects.toMatchObject({ statusCode: 401 });
    expect(signServiceToken).not.toHaveBeenCalled();
  });

  it("無効化された呼出元は 401", async () => {
    fake.queueSelect([project({ isActive: false })]);
    await expect(issueServiceToken(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("呼出先が無効なら 404", async () => {
    fake.queueSelect([project()]);
    fake.queueSelect([target({ isActive: false })]);
    await expect(issueServiceToken(request)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("service_scopes 未宣言の呼出元には発行しない (fail-closed)", async () => {
    fake.queueSelect([project({ schemaDefinition: {} })]);
    fake.queueSelect([target()]);
    await expect(issueServiceToken(request)).rejects.toMatchObject({ statusCode: 403 });
    expect(signServiceToken).not.toHaveBeenCalled();
  });

  it("PASETO 鍵が未設定なら暗黙降格せず 503", async () => {
    pasetoEnabled.mockReturnValue(false);
    fake.queueSelect([project()]);
    fake.queueSelect([target()]);
    await expect(issueServiceToken(request)).rejects.toMatchObject({ statusCode: 503 });
  });
});
