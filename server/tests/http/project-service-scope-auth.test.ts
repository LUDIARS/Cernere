/** onsite attestation の受け口は宣言済み service_scopes の onsite-mfa:submit を要求する。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../identity/fake-drizzle.js";

const fake = createFakeDb();
const credential = vi.hoisted(() => ({ current: true }));
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/project/project-credential-state.js", () => ({
  isCurrentProjectCredential: async () => credential.current,
}));

const { generateProjectToken } = await import("../../src/auth/jwt.js");
const { handleOnsiteAttestation, ONSITE_MFA_SUBMIT_SCOPE } = await import("../../src/http/onsite-attestation-handler.js");
const { requireProjectServiceScope } = await import("../../src/http/project-service-scope-auth.js");

const token = () => `Bearer ${generateProjectToken("client-ostiarius", "Ostiarius", 0)}`;

beforeEach(() => { credential.current = true; });

describe("requireProjectServiceScope", () => {
  it("accepts a current project credential that declares the scope", async () => {
    fake.queueSelect([{ schemaDefinition: { service_scopes: ["face-consent:read", "onsite-mfa:submit"] } }]);
    await expect(requireProjectServiceScope(token(), ONSITE_MFA_SUBMIT_SCOPE))
      .resolves.toEqual({ projectKey: "Ostiarius", clientId: "client-ostiarius" });
  });

  it("returns 403 when the scope is not declared", async () => {
    fake.queueSelect([{ schemaDefinition: { service_scopes: ["face-consent:read"] } }]);
    await expect(handleOnsiteAttestation(token(), { attestation: "x.y" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns 401 without a token or for a rotated credential", async () => {
    await expect(requireProjectServiceScope("", ONSITE_MFA_SUBMIT_SCOPE)).rejects.toMatchObject({ statusCode: 401 });
    credential.current = false;
    await expect(requireProjectServiceScope(token(), ONSITE_MFA_SUBMIT_SCOPE)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a malformed body as invalid_format after authorization", async () => {
    fake.queueSelect([{ schemaDefinition: { service_scopes: ["onsite-mfa:submit"] } }]);
    await expect(handleOnsiteAttestation(token(), { attestation: 1 })).rejects.toMatchObject({ code: "invalid_format" });
  });
});
