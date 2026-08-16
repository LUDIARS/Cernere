import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFaceConsent: vi.fn(),
  exportFaceTemplates: vi.fn(),
  listFaceTemplateStatus: vi.fn(),
  putFaceTemplate: vi.fn(),
  revokeFaceTemplates: vi.fn(),
  requireExportAuth: vi.fn(),
}));

vi.mock("../../src/auth/jwt.js", () => ({
  extractBearerToken: vi.fn(() => "token"),
  verifyToken: vi.fn(() => ({ sub: "11111111-1111-4111-8111-111111111111" })),
}));

vi.mock("../../src/db/connection.js", () => ({ db: { select: vi.fn() } }));

vi.mock("../../src/http/export-auth.js", () => ({
  requireExportAuth: mocks.requireExportAuth,
}));

vi.mock("../../src/identity/face-template-store.js", () => ({
  faceConsentPolicy: { version: "face-template-v1", text: "policy" },
  createFaceConsent: mocks.createFaceConsent,
  exportFaceTemplates: mocks.exportFaceTemplates,
  listFaceTemplateStatus: mocks.listFaceTemplateStatus,
  putFaceTemplate: mocks.putFaceTemplate,
  revokeFaceTemplates: mocks.revokeFaceTemplates,
}));

const { handleFaceTemplateRoute } = await import("../../src/http/face-template-handler.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

describe("face template HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createFaceConsent.mockResolvedValue({ consentId: "consent", at: "2026-01-01T00:00:00.000Z" });
    mocks.putFaceTemplate.mockResolvedValue({ version: 1 });
    mocks.revokeFaceTemplates.mockResolvedValue({ ok: true, removed: 1 });
  });

  it("rejects malformed query UUIDs before they reach the database", async () => {
    await expect(handleFaceTemplateRoute("GET", "status", "", "Bearer token", "facilityId=not-a-uuid"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects malformed base64 templates as a bad request", async () => {
    const body = JSON.stringify({
      userId: USER_ID,
      template: "not base64!",
      modelId: "model-v1",
      quality: 90,
      facilityId: FACILITY_ID,
      enrolledBy: USER_ID,
      consentId: "33333333-3333-4333-8333-333333333333",
    });

    await expect(handleFaceTemplateRoute("PUT", "template", body, "Bearer token", ""))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.putFaceTemplate).not.toHaveBeenCalled();
  });

  it("requires a facility scope for service revocation", async () => {
    await expect(handleFaceTemplateRoute(
      "DELETE",
      `template/${USER_ID}`,
      JSON.stringify({ reason: "membership_removed" }),
      "Bearer token",
      "",
    )).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.revokeFaceTemplates).not.toHaveBeenCalled();
  });

  it("passes a validated, trimmed service revocation to the store", async () => {
    await handleFaceTemplateRoute(
      "DELETE",
      `template/${USER_ID}`,
      JSON.stringify({ reason: "  membership_removed  " }),
      "Bearer token",
      `facilityId=${FACILITY_ID}`,
    );

    expect(mocks.revokeFaceTemplates).toHaveBeenCalledWith(
      USER_ID,
      FACILITY_ID,
      "membership_removed",
      false,
    );
  });
});
