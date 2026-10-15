/**
 * federation/subject.ts の「どのアカウントも連携していない」状態の差し替え。
 * 連携と関係の無い既存テストが、番号の解決のために DB (account_federations) を引かないようにする。
 *
 * 使い方: vi.mock("../../src/federation/subject.js", async () => (await import("../federation/unfederated-subject.js")).unfederatedSubject);
 * 許可状態の判定は user-access.js (各テストのモック) へ委ねるので、既存の許可制のテストの意味は変わらない。
 */
import { eq } from "drizzle-orm";

const resolved = (id: string) => ({ subject: id, primaryUserId: id, federationId: null, detachedFounder: false });

export const unfederatedSubject = {
  FEDERATION_FOUNDER_DETACHED: "federation_founder_detached",
  findMembership: async () => null,
  ownsForeignSubject: async () => false,
  resolveServiceSubject: async (id: string) => resolved(id),
  serviceSubjectId: async (id: string) => id,
  primaryUserIdForSubject: async (id: string) => id,
  accountIdsForSubjectOrUser: async (id: string) => [id],
  requireServiceAccess: async (id: string) => {
    const { requireActiveUser } = await import("../../src/auth/user-access.js");
    await requireActiveUser(id);
    return resolved(id);
  },
  effectiveAccessStatus: async (id: string) => {
    const { getAccessStatus } = await import("../../src/auth/user-access.js");
    return getAccessStatus(id);
  },
  loadServiceIdentity: async (id: string) => {
    const { db } = await import("../../src/db/connection.js");
    const schema = await import("../../src/db/schema.js");
    const row = (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
    if (!row) return null;
    return { subject: id, primaryUserId: id, displayName: row.displayName ?? "", email: row.email ?? null, role: row.role ?? "general" };
  },
};
