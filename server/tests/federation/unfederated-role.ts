/**
 * federation/effective-role.ts の「どのアカウントも連携していない」状態の差し替え。
 * 連携と関係の無い既存テストが、有効な role の解決のために DB (account_federation_members) を引かないようにする。
 *
 * 使い方: vi.mock("../../src/federation/effective-role.js", async () => (await import("../federation/unfederated-role.js")).unfederatedRole);
 * 自分の role は各テストの DB モックから 1 回だけ読む (差し替え前の users.role 1 回読みと同じ)。
 */
import { eq } from "drizzle-orm";

async function loadOwnRole(userId: string): Promise<string | null> {
  const { db } = await import("../../src/db/connection.js");
  const schema = await import("../../src/db/schema.js");
  const row = (await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  return row ? (row.role ?? "general") : null;
}

export const unfederatedRole = {
  loadFederationPrimaryRole: async () => null,
  resolveEffectiveRole: async (_userId: string, ownRole: string) => ownRole,
  loadEffectiveRole: loadOwnRole,
  isEffectiveAdmin: async (userId: string) => (await loadOwnRole(userId)) === "admin",
};
