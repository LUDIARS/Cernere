import { describe, expect, it, vi, beforeEach } from "vitest";

// kiosk 交換は「service 認可 → Redis の one-time 消費 → refreshToken を返さない」
// に加えて token 応答のキャッシュ抑止が要。認可と Redis と DB はモックして配線を見る。
const mocks = vi.hoisted(() => ({
  requireExportAuth: vi.fn(),
  redisGetDel: vi.fn<(key: string) => Promise<string | null>>(),
  deleteWhere: vi.fn(),
  hashRefreshToken: vi.fn((token: string) => `hashed:${token}`),
}));

vi.mock("../../src/http/export-auth.js", () => ({ requireExportAuth: mocks.requireExportAuth }));
vi.mock("../../src/redis.js", () => ({ redis: { getdel: mocks.redisGetDel } }));
vi.mock("../../src/auth/token-hash.js", () => ({ hashRefreshToken: mocks.hashRefreshToken }));
vi.mock("../../src/db/connection.js", () => ({
  db: { delete: () => ({ where: (condition: unknown) => { mocks.deleteWhere(condition); return Promise.resolve(); } }) },
}));

const { handleAuthCodeExchange } = await import("../../src/http/auth-code-exchange-handler.js");

const STORED = JSON.stringify({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  user: { id: "user-1", displayName: "K", email: null, role: "general" },
});

describe("handleAuthCodeExchange", () => {
  beforeEach(() => {
    mocks.requireExportAuth.mockReset();
    mocks.redisGetDel.mockReset();
    mocks.deleteWhere.mockReset();
    mocks.requireExportAuth.mockResolvedValue({ kind: "project", subject: "client-1", projectKey: "ostiarius" });
    mocks.redisGetDel.mockResolvedValue(STORED);
  });

  it("userId と accessToken だけを返し、 refreshToken は返さない", async () => {
    const result = await handleAuthCodeExchange(JSON.stringify({ code: "c1" }), "Bearer service");

    expect(result.status).toBe("200 OK");
    expect(result.data).toEqual({ userId: "user-1", accessToken: "access-1", expiresIn: 900 });
    expect(result.headers).toEqual({ "Cache-Control": "no-store", Pragma: "no-cache" });
    expect(JSON.stringify(result.data)).not.toContain("refresh-1");
  });

  it("authCode を Redis から原子的に取得・削除する (one-time)", async () => {
    await handleAuthCodeExchange(JSON.stringify({ code: "c1" }), "Bearer service");

    expect(mocks.redisGetDel).toHaveBeenCalledOnce();
    expect(mocks.redisGetDel).toHaveBeenCalledWith("authcode:c1");
  });

  it("誰にも渡さない refresh session 行を削除する", async () => {
    await handleAuthCodeExchange(JSON.stringify({ code: "c1" }), "Bearer service");

    expect(mocks.hashRefreshToken).toHaveBeenCalledWith("refresh-1");
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("service 認可に失敗したら Redis を読まない", async () => {
    mocks.requireExportAuth.mockRejectedValue(new Error("Forbidden"));

    await expect(handleAuthCodeExchange(JSON.stringify({ code: "c1" }), "Bearer bad")).rejects.toThrow(/Forbidden/);
    expect(mocks.redisGetDel).not.toHaveBeenCalled();
  });

  it("失効 / 再利用済みの code は 401", async () => {
    mocks.redisGetDel.mockResolvedValue(null);

    await expect(handleAuthCodeExchange(JSON.stringify({ code: "c1" }), "Bearer service"))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it("code が無い body は 400", async () => {
    await expect(handleAuthCodeExchange("{}", "Bearer service")).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.redisGetDel).not.toHaveBeenCalled();
  });
});
