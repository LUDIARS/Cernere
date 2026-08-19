import { describe, expect, it, vi, beforeEach } from "vitest";

// export-auth は「JWT 検証」と「資格情報が今も有効か」の 2 段で判定する。
// ここでは後段 (isCurrentProjectCredential) の配線だけを見たいので、
// jwt / DB 参照はモックして分離する。
const mocks = vi.hoisted(() => ({
  verifyProjectToken: vi.fn(),
  verifyToken: vi.fn(),
  isCurrentProjectCredential: vi.fn(),
  usersRows: vi.fn<() => Array<{ role: string }>>(),
}));

vi.mock("../../src/auth/jwt.js", () => ({
  verifyProjectToken: mocks.verifyProjectToken,
  verifyToken: mocks.verifyToken,
  extractBearerToken: (header: string | undefined) =>
    header?.startsWith("Bearer ") ? header.slice(7) : null,
}));

vi.mock("../../src/project/project-credential-state.js", () => ({
  isCurrentProjectCredential: mocks.isCurrentProjectCredential,
}));

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: (n: number) => Promise.resolve(mocks.usersRows().slice(0, n)) }) }),
    }),
  },
}));

const { requireExportAuth } = await import("../../src/http/export-auth.js");

describe("requireExportAuth の project token 判定", () => {
  beforeEach(() => {
    mocks.verifyProjectToken.mockReset();
    mocks.verifyToken.mockReset();
    mocks.isCurrentProjectCredential.mockReset();
    mocks.usersRows.mockReset();
    mocks.usersRows.mockReturnValue([]);
  });

  it("有効な世代の project token は通る", async () => {
    mocks.verifyProjectToken.mockReturnValue({ sub: "client-1", projectKey: "ostiarius", credentialGeneration: 2 });
    mocks.isCurrentProjectCredential.mockResolvedValue(true);

    await expect(requireExportAuth("Bearer t")).resolves.toEqual({
      kind: "project", subject: "client-1", projectKey: "ostiarius",
    });
    expect(mocks.isCurrentProjectCredential).toHaveBeenCalledWith("client-1", "ostiarius", 2);
  });

  it("rotate 済み / 無効化されたプロジェクトの token は拒否する", async () => {
    mocks.verifyProjectToken.mockReturnValue({ sub: "client-1", projectKey: "ostiarius", credentialGeneration: 1 });
    mocks.isCurrentProjectCredential.mockResolvedValue(false);

    await expect(requireExportAuth("Bearer t")).rejects.toThrow(/inactive or rotated/);
  });

  it("資格情報の現行性を確認できない場合は user token 判定へ降格しない", async () => {
    mocks.verifyProjectToken.mockReturnValue({
      sub: "client-1",
      projectKey: "ostiarius",
      credentialGeneration: 2,
    });
    mocks.isCurrentProjectCredential.mockRejectedValue(new Error("database unavailable"));

    await expect(requireExportAuth("Bearer t")).rejects.toThrow(/database unavailable/);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it("credentialGeneration が無い旧 token は世代 0 として問い合わせる", async () => {
    mocks.verifyProjectToken.mockReturnValue({ sub: "client-1", projectKey: "ostiarius" });
    mocks.isCurrentProjectCredential.mockResolvedValue(true);

    await expect(requireExportAuth("Bearer t")).resolves.toEqual({
      kind: "project", subject: "client-1", projectKey: "ostiarius",
    });
    expect(mocks.isCurrentProjectCredential).toHaveBeenCalledWith("client-1", "ostiarius", 0);
  });

  it("project token でなければ user token として admin 判定へ落ちる", async () => {
    mocks.verifyProjectToken.mockImplementation(() => { throw new Error("not a project token"); });
    mocks.verifyToken.mockReturnValue({ sub: "user-1" });
    mocks.usersRows.mockReturnValue([{ role: "admin" }]);

    await expect(requireExportAuth("Bearer t")).resolves.toEqual({ kind: "admin", subject: "user-1" });
    expect(mocks.isCurrentProjectCredential).not.toHaveBeenCalled();
  });
});
