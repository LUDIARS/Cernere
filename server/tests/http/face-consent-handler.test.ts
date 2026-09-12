/**
 * 同意 API の認可と入力検証。
 *
 * - 同意記録の配布 / kiosk 由来の撤回は scope 必須 (無ければ 403)
 * - 立会い職員 (revokedBy) は施設の reviewer role を現に持っていること
 * - 契約に無い失効理由は受理しない
 * - 撤去済みの旧 face-template / face-photo 経路は 404
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFaceConsent: vi.fn(),
  listFaceConsents: vi.fn(),
  listOwnFaceConsents: vi.fn(),
  revokeFaceConsents: vi.fn(),
  requireFaceReviewer: vi.fn(),
  requireServiceScope: vi.fn(),
  recordFaceAudit: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("../../src/identity/face-consent-store.js", () => ({
  faceConsentPolicy: { version: "face-local-v1", text: "policy", policies: [] },
  createFaceConsent: mocks.createFaceConsent,
  listFaceConsents: mocks.listFaceConsents,
  listOwnFaceConsents: mocks.listOwnFaceConsents,
  revokeFaceConsents: mocks.revokeFaceConsents,
}));
vi.mock("../../src/identity/face-consent-guard.js", () => ({
  requireFaceReviewer: mocks.requireFaceReviewer,
}));
vi.mock("../../src/http/service-scope-auth.js", () => ({
  requireServiceScope: mocks.requireServiceScope,
}));
vi.mock("../../src/logging/face-audit.js", () => ({ recordFaceAudit: mocks.recordFaceAudit }));
vi.mock("../../src/http/face-identity-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/http/face-identity-auth.js")>()),
  currentUser: mocks.currentUser,
}));

const { handleFaceConsentRoute } = await import("../../src/http/face-consent-handler.js");
const { AppError } = await import("../../src/error.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";

const PRINCIPAL = { kind: "tool" as const, subject: "tool-1", actorUserId: STAFF_ID };

describe("face consent HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue(USER_ID);
    mocks.createFaceConsent.mockResolvedValue({ consentId: "c1", at: "2026-09-12T00:00:00.000Z" });
    mocks.listOwnFaceConsents.mockResolvedValue({ items: [] });
    mocks.listFaceConsents.mockResolvedValue([]);
    mocks.revokeFaceConsents.mockResolvedValue({ ok: true, revoked: 1, facilities: [FACILITY_ID] });
    mocks.requireServiceScope.mockResolvedValue(PRINCIPAL);
    mocks.requireFaceReviewer.mockResolvedValue(undefined);
  });

  it("同意文は認証なしでも取得できる (同意画面が版を取るため)", async () => {
    const result = await handleFaceConsentRoute("GET", "policy", "", "", "");
    expect(result.status).toBe("200 OK");
    expect(result.data).toMatchObject({ version: "face-local-v1" });
  });

  it("同意は本人 token で記録し、service token で代筆させない", async () => {
    const body = JSON.stringify({ policyVersion: "face-local-v1", facilityId: FACILITY_ID });
    const result = await handleFaceConsentRoute("POST", "consent", body, "Bearer token", "");

    expect(mocks.currentUser).toHaveBeenCalledWith("Bearer token");
    expect(mocks.createFaceConsent).toHaveBeenCalledWith(USER_ID, "face-local-v1", FACILITY_ID);
    expect(result.status).toBe("201 Created");
  });

  it("本人撤回は自分の userId と withdrawn で失効指示を積ませる", async () => {
    await handleFaceConsentRoute("DELETE", "consent", "", "Bearer token", `facilityId=${FACILITY_ID}`);

    expect(mocks.revokeFaceConsents).toHaveBeenCalledWith(USER_ID, FACILITY_ID, "withdrawn");
  });

  it("不正な facilityId は DB へ届く前に 400", async () => {
    await expect(handleFaceConsentRoute("GET", "status", "", "Bearer token", "facilityId=not-a-uuid"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("scope face-consent:read が無ければ同意記録を配布しない", async () => {
    mocks.requireServiceScope.mockRejectedValue(AppError.forbidden("Scope face-consent:read is required"));

    await expect(handleFaceConsentRoute("GET", "consents", "", "Bearer token", `facilityId=${FACILITY_ID}`))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.listFaceConsents).not.toHaveBeenCalled();
  });

  it("同意記録の配布は facilityId 必須", async () => {
    await expect(handleFaceConsentRoute("GET", "consents", "", "Bearer token", ""))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("scope face-consent:revoke が無ければ kiosk 由来の撤回を受けない", async () => {
    mocks.requireServiceScope.mockRejectedValue(AppError.forbidden("Scope face-consent:revoke is required"));
    const body = JSON.stringify({ userId: USER_ID, facilityId: FACILITY_ID, revokedBy: STAFF_ID });

    await expect(handleFaceConsentRoute("POST", "consent/revoke", body, "Bearer token", ""))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.revokeFaceConsents).not.toHaveBeenCalled();
  });

  it("kiosk 由来の撤回は既定で withdrawn を積む", async () => {
    const body = JSON.stringify({ userId: USER_ID, facilityId: FACILITY_ID, revokedBy: STAFF_ID });
    await handleFaceConsentRoute("POST", "consent/revoke", body, "Bearer token", "");

    expect(mocks.requireFaceReviewer).toHaveBeenCalledWith(STAFF_ID, FACILITY_ID);
    expect(mocks.revokeFaceConsents).toHaveBeenCalledWith(USER_ID, FACILITY_ID, "withdrawn");
  });

  it("職員無効化など、契約にある理由は受理する", async () => {
    const body = JSON.stringify({
      userId: USER_ID, facilityId: FACILITY_ID, revokedBy: STAFF_ID, reason: "staff_invalidated",
    });
    await handleFaceConsentRoute("POST", "consent/revoke", body, "Bearer token", "");

    expect(mocks.revokeFaceConsents).toHaveBeenCalledWith(USER_ID, FACILITY_ID, "staff_invalidated");
  });

  it("契約に無い理由は 400 で、同意を触らない", async () => {
    const body = JSON.stringify({
      userId: USER_ID, facilityId: FACILITY_ID, revokedBy: STAFF_ID, reason: "membership_removed",
    });

    await expect(handleFaceConsentRoute("POST", "consent/revoke", body, "Bearer token", ""))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.revokeFaceConsents).not.toHaveBeenCalled();
  });

  it("立会い職員が施設の reviewer でなければ撤回しない", async () => {
    mocks.requireFaceReviewer.mockRejectedValue(AppError.forbidden("reviewer required"));
    const body = JSON.stringify({ userId: USER_ID, facilityId: FACILITY_ID, revokedBy: STAFF_ID });

    await expect(handleFaceConsentRoute("POST", "consent/revoke", body, "Bearer token", ""))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.revokeFaceConsents).not.toHaveBeenCalled();
  });

  it("撤去した旧 face-template / face-photo 経路は 404", async () => {
    const legacy: Array<[string, string]> = [
      ["PUT", "template"],
      ["DELETE", "template"],
      ["DELETE", `template/${USER_ID}`],
      ["GET", "export"],
      ["POST", "photo"],
      ["GET", "photo/me"],
      ["GET", `photo/${USER_ID}`],
      ["POST", `template/${USER_ID}/promote`],
      ["POST", `template/${USER_ID}/reject`],
    ];
    for (const [method, path] of legacy) {
      await expect(handleFaceConsentRoute(method, path, "{}", "Bearer token", ""))
        .rejects.toMatchObject({ statusCode: 404 });
    }
  });
});
