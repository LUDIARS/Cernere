/**
 * Device Credential の HTTP 経路の入口検証
 * (spec/plan/passkey-default-authentication.md §10.1 / §11.4)
 *
 * silent login は「ユーザー操作なしで認証が成立する」 経路なので、 DB へ届く前の
 * 境界 (Origin / rotation_id の形式) で落ちることを確かめる。 ここが緩いと、
 * 任意ヘッダが UUID 列へ流れて公開経路に 500 が出る。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/redis.js", () => ({ checkRateLimit: async () => {} }));

const ORIGIN = "https://cernere.example.com";

vi.mock("../../src/config.js", () => ({
  config: {
    webauthnOrigins: [ORIGIN],
    frontendUrl: ORIGIN,
    isDevelopment: false,
    deviceSessionsEnabled: true,
  },
}));

// DB へ触らせない。 境界で弾かれる限りこれらは呼ばれないことも併せて確認する。
const rotateDeviceSession = vi.fn();
const resolveDeviceSession = vi.fn();
const revokeDeviceCredential = vi.fn();
const revokeAllDeviceCredentials = vi.fn();
const listDeviceCredentials = vi.fn();

vi.mock("../../src/auth/device-credential.js", () => ({
  rotateDeviceSession: (...a: unknown[]) => rotateDeviceSession(...a),
  resolveDeviceSession: (...a: unknown[]) => resolveDeviceSession(...a),
  revokeDeviceCredential: (...a: unknown[]) => revokeDeviceCredential(...a),
  revokeAllDeviceCredentials: (...a: unknown[]) => revokeAllDeviceCredentials(...a),
  listDeviceCredentials: (...a: unknown[]) => listDeviceCredentials(...a),
}));

vi.mock("../../src/auth/jwt.js", () => ({
  extractBearerToken: (h: string) => (h.startsWith("Bearer ") ? h.slice(7) : null),
  // 本体は async。 同期値を返すと await が素通りし、 await 漏れを検出できない。
  verifyToken: async () => ({ sub: "user-1" }),
  generateAccessToken: async (userId: string, role: string) => `token:${userId}:${role}`,
}));

vi.mock("../../src/logging/dev-logger.js", () => ({ devLog: () => {} }));

const { handleDeviceRoute } = await import("../../src/http/device-handler.js");

const ROTATION_ID = "11111111-2222-3333-4444-555555555555";

function ctx(over: Record<string, unknown> = {}) {
  return {
    cookieHeader: "",
    origin: ORIGIN,
    hostname: "cernere.example.com",
    rotationId: ROTATION_ID,
    ...over,
  } as Parameters<typeof handleDeviceRoute>[3];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("session — Origin 検証", () => {
  it("Origin 無しの POST を拒否する (fail-closed)", async () => {
    await expect(handleDeviceRoute("session", "", "", ctx({ origin: "" })))
      .rejects.toThrow(/Origin header is required/);
    expect(rotateDeviceSession).not.toHaveBeenCalled();
  });

  it("許可外 origin を拒否する", async () => {
    await expect(handleDeviceRoute("session", "", "", ctx({ origin: "https://evil.tld" })))
      .rejects.toThrow(/Origin is not allowed/);
    expect(rotateDeviceSession).not.toHaveBeenCalled();
  });

  it("近縁ドメインを前方/後方一致で通さない", async () => {
    // `https://cernere.example.com.evil.tld` を通すと silent login が奪われる。
    for (const bad of [`${ORIGIN}.evil.tld`, "https://evil.tld?x=" + ORIGIN]) {
      await expect(handleDeviceRoute("session", "", "", ctx({ origin: bad })))
        .rejects.toThrow(/Origin is not allowed/);
    }
  });
});

describe("session — rotation_id の形式", () => {
  it("ヘッダ欠落を 400 にする", async () => {
    await expect(handleDeviceRoute("session", "", "", ctx({ rotationId: "" })))
      .rejects.toThrow(/X-Cernere-Rotation-Id header is required/);
  });

  it("UUID でない rotation_id を DB へ流さない", async () => {
    // last_rotation_id は UUID 列。 素通しすると Postgres の型エラーが
    // 公開経路の 500 になって出る。
    for (const bad of ["abc", "logout", "'; DROP TABLE device_credentials; --"]) {
      await expect(handleDeviceRoute("session", "", "", ctx({ rotationId: bad })))
        .rejects.toThrow(/must be a UUID/);
    }
    expect(rotateDeviceSession).not.toHaveBeenCalled();
  });
});

describe("session — access token のロール", () => {
  it("固定値ではなく DB の実ロールを載せる", async () => {
    // ここを "general" 固定にすると admin が silent login のたびに降格する。
    rotateDeviceSession.mockResolvedValue({
      userId: "user-1",
      role: "admin",
      deviceId: "dev-1",
      token: "cdt1.x.y",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      authEpoch: 0,
    });
    const res = await handleDeviceRoute("session", "", "", ctx());
    expect((res.data as { accessToken: string }).accessToken).toBe("token:user-1:admin");
  });
});

describe("logout", () => {
  it("rotation_id ヘッダが無くても端末を失効させる", async () => {
    // 以前は rotation を走らせていたため、 ヘッダ無し logout が内部で失敗し
    // Cookie だけ消えて行が生き残っていた。
    resolveDeviceSession.mockResolvedValue({ userId: "user-1", deviceId: "dev-1" });
    const res = await handleDeviceRoute("logout", "", "", ctx({
      rotationId: "",
      cookieHeader: `__Host-cernere-device=cdt1.11111111-2222-3333-4444-555555555555.s3cr3t`,
    }));

    expect(revokeDeviceCredential).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "dev-1", reason: "logout" }),
    );
    // logout は状態を進めない。
    expect(rotateDeviceSession).not.toHaveBeenCalled();
    expect(res.cookies?.[0]).toContain("Max-Age=0");
  });

  it("特定できない Cookie でも成功扱いで Cookie を消す", async () => {
    resolveDeviceSession.mockResolvedValue(null);
    const res = await handleDeviceRoute("logout", "", "", ctx({
      cookieHeader: "__Host-cernere-device=cdt1.11111111-2222-3333-4444-555555555555.bad",
    }));
    expect(res.status).toBe("200 OK");
    expect(revokeDeviceCredential).not.toHaveBeenCalled();
  });
});

describe("connected-session revocation boundary", () => {
  it("rejects REST revocation even with a user bearer", async () => {
    for (const action of ["revoke", "revoke-all"]) {
      await expect(handleDeviceRoute(action, JSON.stringify({ deviceId: "dev-1" }), "Bearer t", ctx()))
        .rejects.toThrow(/authenticated.*WebSocket/);
    }
    expect(revokeDeviceCredential).not.toHaveBeenCalled();
    expect(revokeAllDeviceCredentials).not.toHaveBeenCalled();
  });
});
