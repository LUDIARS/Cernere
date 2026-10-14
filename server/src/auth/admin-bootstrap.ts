/**
 * admin の明示付与 (SPEC-ADMIN-BOOTSTRAP)。
 *
 * パスキーのみ認証では誰でも公開 signup でアカウントを作れるため、「最初のユーザーを admin」
 * にすると先着者が管理権限を取れる。admin はサーバー上の運用者がこの関数 (scripts/bootstrap-admin.ts)
 * で付ける。admin はリカバリー QR で回復できないので、付ける前に 2 本目のパスキーを勧める。
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

export interface BootstrapAdminResult {
  userId: string;
  changed: boolean;
  activePasskeys: number;
}

export async function grantAdminRole(userId: string): Promise<BootstrapAdminResult> {
  const id = z.string().uuid().parse(userId);
  return db.transaction(async (tx) => {
    const user = (await tx.select({ role: schema.users.role, authEpoch: schema.users.authEpoch, accessStatus: schema.users.accessStatus, accessRevision: schema.users.accessRevision })
      .from(schema.users).where(eq(schema.users.id, id)).for("update"))[0];
    if (!user) throw new Error(`User ${id} not found`);
    const passkeys = await tx.select({ revokedAt: schema.passkeys.revokedAt }).from(schema.passkeys)
      .where(eq(schema.passkeys.userId, id));
    const activePasskeys = passkeys.filter((p) => !p.revokedAt).length;
    if (user.role === "admin" && user.accessStatus === "active") return { userId: id, changed: false, activePasskeys };
    // role を変えたら既存トークンの role クレームを失効させる (次のリクエストで再ログイン)。
    // 運用者が明示した admin は利用許可も済ませる (許可制 案 A。最初の admin は審査する人がいない)。
    await tx.update(schema.users).set({
      role: "admin",
      accessStatus: "active",
      accessRevision: user.accessRevision + 1,
      accessChangedAt: new Date(),
      authEpoch: user.authEpoch + 1,
      updatedAt: new Date(),
    }).where(eq(schema.users.id, id));
    return { userId: id, changed: true, activePasskeys };
  });
}
