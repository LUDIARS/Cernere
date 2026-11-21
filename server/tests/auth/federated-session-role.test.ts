/**
 * Cernere のユーザセッションの role は有効な role (連携していれば主の role、account-federation §3.1)。
 *   - トークンに入る role・セッションの照合に使う role は主のもの
 *   - 連携前に発行された自分の role のトークンは食い違いで失効し、refresh で主の role に揃う
 *   - 発行の呼び出し側が自分の users.role を渡しても発行できる
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ effective: vi.fn(async (_userId: string, ownRole: string) => ownRole) }));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/config.js", () => ({ config: { deviceSessionsEnabled: false } }));
vi.mock("../../src/federation/effective-role.js", () => ({ resolveEffectiveRole: mocks.effective }));

const { users } = await import("../../src/db/schema.js");
const { assertUserSessionCurrent, currentUserSessionState, issuedRoleMatchesCurrent } = await import("../../src/auth/user-session-state.js");
type SessionReader = import("../../src/auth/user-session-state.js").SessionReader;

const PC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let row: { sub: string; role: string; authEpoch: number; mfaRevision: number; accessStatus: string };
const reader = { select: () => ({ from: (table: unknown) => {
  if (table !== users) throw new Error("unexpected table");
  return { where: () => ({ limit: async () => [row] }) };
} }) } as unknown as SessionReader;

beforeEach(() => {
  row = { sub: PC, role: "general", authEpoch: 1, mfaRevision: 0, accessStatus: "active" };
  mocks.effective.mockReset();
  mocks.effective.mockImplementation(async (_userId: string, ownRole: string) => ownRole);
});

describe("連携したアカウントのセッションの role", () => {
  it("主が admin なら、PC (general) のセッションの role は admin", async () => {
    mocks.effective.mockResolvedValue("admin");
    expect(await currentUserSessionState(PC, reader)).toMatchObject({ sub: PC, role: "admin" });
    expect(mocks.effective).toHaveBeenCalledWith(PC, "general", reader);
  });

  it("連携前に発行した general のトークンは失効し、admin のトークンは通る", async () => {
    mocks.effective.mockResolvedValue("admin");
    await expect(assertUserSessionCurrent({ sub: PC, role: "general", authEpoch: 1, mfaRevision: 0 }, reader))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(assertUserSessionCurrent({ sub: PC, role: "admin", authEpoch: 1, mfaRevision: 0 }, reader))
      .resolves.toBeUndefined();
  });

  it("連携していなければ自分の role のまま", async () => {
    expect(await currentUserSessionState(PC, reader)).toMatchObject({ role: "general" });
    await expect(assertUserSessionCurrent({ sub: PC, role: "admin", authEpoch: 1, mfaRevision: 0 }, reader))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("連携を外れたら admin のトークンは失効し、自分の role に戻る", async () => {
    mocks.effective.mockResolvedValue("admin");
    await expect(assertUserSessionCurrent({ sub: PC, role: "admin", authEpoch: 1, mfaRevision: 0 }, reader)).resolves.toBeUndefined();
    mocks.effective.mockImplementation(async (_userId: string, ownRole: string) => ownRole);
    await expect(assertUserSessionCurrent({ sub: PC, role: "admin", authEpoch: 1, mfaRevision: 0 }, reader))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(await currentUserSessionState(PC, reader)).toMatchObject({ role: "general" });
  });
});

describe("issuedRoleMatchesCurrent (発行の呼び出し側が渡した role の照合)", () => {
  it("有効な role でも、アカウント自身の users.role でも合っているとみなす", async () => {
    expect(await issuedRoleMatchesCurrent(PC, "admin", "admin", reader)).toBe(true);
    expect(await issuedRoleMatchesCurrent(PC, "general", "admin", reader)).toBe(true);
  });

  it("どちらとも違えば (読んだ後に role が変わった) 合っていない", async () => {
    row.role = "general";
    expect(await issuedRoleMatchesCurrent(PC, "admin", "general", reader)).toBe(false);
  });
});
