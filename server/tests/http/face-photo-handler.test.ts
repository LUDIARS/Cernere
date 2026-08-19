/**
 * 顔写真 API の HTTP 境界テスト。保存境界 (store) は mock し、
 * 認可・入力検証・応答形だけを見る。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveFacePhoto: vi.fn(),
  readFacePhoto: vi.fn(),
  deleteFacePhoto: vi.fn(),
  promoteFaceTemplate: vi.fn(),
  rejectFaceTemplate: vi.fn(),
  requireServiceScope: vi.fn(),
  recordFaceAudit: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("../../src/auth/jwt.js", () => ({
  extractBearerToken: vi.fn(() => "token"),
  verifyToken: mocks.verifyToken,
}));
vi.mock("../../src/http/service-scope-auth.js", () => ({ requireServiceScope: mocks.requireServiceScope }));
vi.mock("../../src/logging/face-audit.js", () => ({ recordFaceAudit: mocks.recordFaceAudit }));
vi.mock("../../src/identity/face-photo-store.js", () => ({
  saveFacePhoto: mocks.saveFacePhoto,
  readFacePhoto: mocks.readFacePhoto,
  deleteFacePhoto: mocks.deleteFacePhoto,
  promoteFaceTemplate: mocks.promoteFaceTemplate,
  rejectFaceTemplate: mocks.rejectFaceTemplate,
}));

const { handleFacePhotoRoute } = await import("../../src/http/face-photo-handler.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const FACILITY_ID = "22222222-2222-4222-8222-222222222222";
const AUTH = "Bearer token";

function multipart(bytes: Buffer, mime = "image/jpeg"): { body: Buffer; contentType: string } {
  const boundary = "----cernere-test";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="face.jpg"\r\nContent-Type: ${mime}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("face photo HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyToken.mockReturnValue({ sub: USER_ID, role: "user" });
    mocks.requireServiceScope.mockResolvedValue({
      kind: "tool",
      subject: "svc",
      actorUserId: USER_ID,
    });
    mocks.deleteFacePhoto.mockResolvedValue({ ok: true, removedTemplates: 1 });
    mocks.rejectFaceTemplate.mockResolvedValue({ ok: true, removedTemplates: 1 });
    mocks.promoteFaceTemplate.mockResolvedValue({ ok: true, state: "active", version: 2 });
    mocks.readFacePhoto.mockResolvedValue({ bytes: Buffer.from([1, 2, 3]), mime: "image/jpeg" });
  });

  it("multipart の 1 枚を store へ渡し、201 を返す", async () => {
    mocks.saveFacePhoto.mockResolvedValue({ width: 1024, height: 768, byteSize: 100, templateState: "pending", version: 1 });
    const { body, contentType } = multipart(Buffer.from("image-bytes"));
    const result = await handleFacePhotoRoute({
      method: "POST", path: "photo", body, contentType, authHeader: AUTH, query: `facilityId=${FACILITY_ID}`,
    });
    expect(result.status).toBe("201 Created");
    expect(mocks.saveFacePhoto).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, facilityId: FACILITY_ID, mime: "image/jpeg" }));
  });

  it("同意が無ければ 409 consent_required をそのまま返す", async () => {
    mocks.saveFacePhoto.mockRejectedValue(Object.assign(new Error("consent_required"), { statusCode: 409 }));
    const { body, contentType } = multipart(Buffer.from("image-bytes"));
    await expect(handleFacePhotoRoute({
      method: "POST", path: "photo", body, contentType, authHeader: AUTH, query: `facilityId=${FACILITY_ID}`,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("画像取得は binary + private,no-store 前提の応答になる", async () => {
    const result = await handleFacePhotoRoute({
      method: "GET", path: "photo/me", body: Buffer.alloc(0), contentType: "", authHeader: AUTH, query: "",
    });
    expect(result.binary?.contentType).toBe("image/jpeg");
    expect(result.data).toBeUndefined();
  });

  it("service の単体取得は face-photo:read scope を要求する", async () => {
    await handleFacePhotoRoute({
      method: "GET", path: `photo/${TARGET_ID}`, body: Buffer.alloc(0), contentType: "", authHeader: AUTH, query: "",
    });
    expect(mocks.requireServiceScope).toHaveBeenCalledWith(AUTH, "face-photo:read");
  });

  it("本人経路では project token を user token として受理しない", async () => {
    mocks.verifyToken.mockReturnValue({
      sub: USER_ID,
      projectKey: "unrelated-project",
      tokenType: "project",
    });
    await expect(handleFacePhotoRoute({
      method: "DELETE", path: "photo", body: Buffer.alloc(0), contentType: "", authHeader: AUTH, query: "",
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.deleteFacePhoto).not.toHaveBeenCalled();
  });

  it("/face-photo/me の DELETE alias も本人削除として扱う", async () => {
    await handleFacePhotoRoute({
      method: "DELETE", path: "photo/me", body: Buffer.alloc(0), contentType: "", authHeader: AUTH, query: "",
    });
    expect(mocks.deleteFacePhoto).toHaveBeenCalledWith(USER_ID, "user_deleted_photo");
    expect(mocks.requireServiceScope).not.toHaveBeenCalled();
  });

  it("reason の無い reject は 400 で弾く", async () => {
    const body = Buffer.from(JSON.stringify({ enrolledBy: USER_ID, facilityId: FACILITY_ID }), "utf8");
    await expect(handleFacePhotoRoute({
      method: "POST", path: `template/${TARGET_ID}/reject`, body, contentType: "application/json", authHeader: AUTH, query: "",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.rejectFaceTemplate).not.toHaveBeenCalled();
  });

  it("reason 付きの reject は store を呼び、監査に理由を残す", async () => {
    const body = Buffer.from(JSON.stringify({ enrolledBy: USER_ID, facilityId: FACILITY_ID, reason: "本人と一致しない" }), "utf8");
    await handleFacePhotoRoute({
      method: "POST", path: `template/${TARGET_ID}/reject`, body, contentType: "application/json", authHeader: AUTH, query: "",
    });
    expect(mocks.rejectFaceTemplate).toHaveBeenCalledWith(expect.objectContaining({ reason: "本人と一致しない" }));
    expect(mocks.requireServiceScope).toHaveBeenCalledWith(AUTH, "face-photo:manage");
    expect(mocks.recordFaceAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity.face_template.reject" }));
  });

  it("認証 actor と異なる enrolledBy による reviewer 偽装を拒否する", async () => {
    const delegatedUserId = "33333333-3333-4333-8333-333333333333";
    const body = Buffer.from(JSON.stringify({
      enrolledBy: delegatedUserId,
      facilityId: FACILITY_ID,
      reason: "本人と一致しない",
    }), "utf8");

    await expect(handleFacePhotoRoute({
      method: "POST",
      path: `template/${TARGET_ID}/reject`,
      body,
      contentType: "application/json",
      authHeader: AUTH,
      query: "",
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.rejectFaceTemplate).not.toHaveBeenCalled();
    expect(mocks.recordFaceAudit).not.toHaveBeenCalled();
  });

  it("一括取得のような未定義ルートは 404", async () => {
    await expect(handleFacePhotoRoute({
      method: "GET", path: "photo", body: Buffer.alloc(0), contentType: "", authHeader: AUTH, query: "",
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});
