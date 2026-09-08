/** Operator-issued, purpose-bound recovery grants. @implements SPEC-DEVICE-RECOVERY */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";

export const REGISTRATION_GRANT_TTL_MS = 15 * 60 * 1000;
export interface IssuedGrant { grantId: string; token: string; expiresAt: Date }
export interface RecoveryGrantOptions {
  subjectUserId: string; createdByUserId: string;
  revokePasskeyIds?: string[]; revokeAllExistingPasskeys?: boolean; now?: Date;
}
export type RecoveryTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function hashGrantToken(token: string): string {
  if (!tokenSchema.safeParse(token).success) throw AppError.unauthorized("Invalid recovery token");
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRecoveryGrant(opts: RecoveryGrantOptions): Promise<IssuedGrant> {
  const scope = z.object({ subjectUserId: z.string().uuid(), createdByUserId: z.string().uuid(),
    revokePasskeyIds: z.array(z.string().uuid()).max(100), revokeAllExistingPasskeys: z.boolean() })
    .safeParse({ ...opts, revokePasskeyIds: opts.revokePasskeyIds ?? [], revokeAllExistingPasskeys: opts.revokeAllExistingPasskeys ?? false });
  if (!scope.success) throw AppError.badRequest("Invalid recovery scope");
  const ids = [...new Set(scope.data.revokePasskeyIds)];
  const all = scope.data.revokeAllExistingPasskeys;
  if (all === (ids.length > 0)) throw AppError.badRequest("Select either all passkeys or specific passkeys");
  const token = randomBytes(32).toString("base64url"), grantId = randomUUID();
  const now = opts.now ?? new Date(), expiresAt = new Date(now.getTime() + REGISTRATION_GRANT_TTL_MS);
  await db.transaction(async tx => {
    // actor も行ロックして読む。 ロック無しだと READ COMMITTED では
    // 直前に commit された降格 / 全端末失効 (auth_epoch 進行) が見えず、
    // 既に失効した管理者が 15 分有効な回復 grant を発行できてしまう。
    //
    // 2 行を掴むので、 掛ける順序を id の昇順に固定する。 要求順のまま掴むと
    // 「管理者 A が B を回復」 と「B が A を回復」 が同時に走ったときに
    // 互いを待ち合って deadlock (40P01) になる。
    const lockIds = [...new Set([opts.subjectUserId, opts.createdByUserId])].sort();
    const locked = new Map<string, typeof schema.users.$inferSelect>();
    for (const id of lockIds) {
      const row = (await tx.select().from(schema.users).where(eq(schema.users.id, id)).for("update"))[0];
      if (row) locked.set(id, row);
    }
    const target = locked.get(opts.subjectUserId);
    const actor = locked.get(opts.createdByUserId);
    if (!target || actor?.role !== "admin") throw AppError.forbidden("An active administrator and existing target user are required");
    const passkeys = await tx.select({ id: schema.passkeys.id }).from(schema.passkeys)
      .where(and(eq(schema.passkeys.userId, target.id), isNull(schema.passkeys.revokedAt)));
    if (ids.some(id => !passkeys.some(key => key.id === id))) throw AppError.badRequest("Recovery scope contains an unavailable passkey");
    await tx.insert(schema.registrationGrants).values({
      id: grantId, purpose: "recover_user", subjectUserId: target.id, revokePasskeyIds: ids,
      revokeAllExistingPasskeys: all, tokenHash: hashGrantToken(token), expiresAt,
      createdByUserId: actor.id, createdAt: now, targetAuthEpoch: target.authEpoch,
      issuerAuthEpoch: actor.authEpoch, issuerMfaRevision: actor.mfaRevision,
    });
  });
  return { grantId, token, expiresAt };
}

async function requireGrant(token: string, reader: Pick<typeof db, "select">, now: Date) {
  const grant = (await reader.select().from(schema.registrationGrants).where(eq(schema.registrationGrants.tokenHash, hashGrantToken(token))).limit(1))[0];
  if (!grant || grant.purpose !== "recover_user" || !grant.subjectUserId || !grant.createdByUserId
    || grant.usedAt || grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()
    || grant.targetAuthEpoch === null || grant.issuerAuthEpoch === null || grant.issuerMfaRevision === null) {
    throw AppError.unauthorized("Invalid or expired recovery token");
  }
  return grant;
}

export async function resolveGrant(token: string, now = new Date()) {
  const grant = await requireGrant(token, db, now);
  return { grantId: grant.id, subjectUserId: grant.subjectUserId as string, expiresAt: grant.expiresAt, purpose: "recover_user" as const };
}

/** Re-read scope under the user/grant locks; callers cannot supply revocation targets. */
export async function completeRecovery(params: {
  token: string; expectedSubjectUserId: string;
  insertPasskey: (tx: RecoveryTx, userId: string) => Promise<void>;
  now?: Date;
}): Promise<void> {
  const initial = await requireGrant(params.token, db, params.now ?? new Date());
  await db.transaction(async tx => {
    const user = (await tx.select().from(schema.users).where(eq(schema.users.id, initial.subjectUserId as string)).for("update"))[0];
    await tx.select({ id: schema.registrationGrants.id }).from(schema.registrationGrants).where(eq(schema.registrationGrants.id, initial.id)).for("update");
    const grant = await requireGrant(params.token, tx, params.now ?? new Date());
    const actor = (await tx.select().from(schema.users).where(eq(schema.users.id, grant.createdByUserId as string)).limit(1))[0];
    if (!user || user.id !== grant.subjectUserId || user.id !== params.expectedSubjectUserId || user.authEpoch !== grant.targetAuthEpoch
      || actor?.role !== "admin" || actor.authEpoch !== grant.issuerAuthEpoch || actor.mfaRevision !== grant.issuerMfaRevision) {
      throw AppError.unauthorized("Recovery authorization changed");
    }
    const ids = z.array(z.string().uuid()).max(100).parse(grant.revokePasskeyIds);
    if (grant.revokeAllExistingPasskeys === (ids.length > 0)) throw AppError.unauthorized("Invalid recovery scope");
    const now = params.now ?? new Date();
    for (const key of await tx.select({ id: schema.passkeys.id }).from(schema.passkeys)
      .where(and(eq(schema.passkeys.userId, user.id), isNull(schema.passkeys.revokedAt)))) {
      if (grant.revokeAllExistingPasskeys || ids.includes(key.id)) {
        await tx.update(schema.passkeys).set({ revokedAt: now }).where(eq(schema.passkeys.id, key.id));
      }
    }
    await params.insertPasskey(tx, user.id);
    await tx.update(schema.deviceCredentials).set({ revokedAt: now, revokedReason: "recovery" })
      .where(and(eq(schema.deviceCredentials.userId, user.id), isNull(schema.deviceCredentials.revokedAt)));
    await tx.delete(schema.refreshSessions).where(eq(schema.refreshSessions.userId, user.id));
    await tx.update(schema.users).set({ authEpoch: user.authEpoch + 1, mfaRevision: user.mfaRevision + 1 }).where(eq(schema.users.id, user.id));
    await tx.update(schema.registrationGrants).set({ usedAt: now }).where(eq(schema.registrationGrants.id, grant.id));
  });
}

export async function revokeGrant(grantId: string, actorUserId: string): Promise<boolean> {
  const actor = (await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, actorUserId)).limit(1))[0];
  if (actor?.role !== "admin") throw AppError.forbidden("Administrator required");
  // purpose を絞る。 この経路は account_recovery.revoke 専用なので、
  // bootstrap / create_user / email_enroll の grant まで取り消せてはいけない。
  //
  // completeRecovery と同じ順序 (users → registration_grants) でロックを取る。
  // ここだけ grant を直接 UPDATE すると、 回復完了と取り消しが競合したときに
  // 逆順ロックとなり deadlock (40P01) が 500 として表面化する。
  return db.transaction(async tx => {
    const grant = (await tx.select({
      id: schema.registrationGrants.id,
      subjectUserId: schema.registrationGrants.subjectUserId,
    }).from(schema.registrationGrants)
      .where(and(
        eq(schema.registrationGrants.id, grantId),
        eq(schema.registrationGrants.purpose, "recover_user"),
        isNull(schema.registrationGrants.usedAt),
        isNull(schema.registrationGrants.revokedAt),
      )).limit(1))[0];
    if (!grant) return false;
    if (grant.subjectUserId) {
      await tx.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.id, grant.subjectUserId)).for("update");
    }
    const rows = await tx.update(schema.registrationGrants).set({ revokedAt: new Date() })
      .where(and(
        eq(schema.registrationGrants.id, grantId),
        eq(schema.registrationGrants.purpose, "recover_user"),
        isNull(schema.registrationGrants.usedAt),
        isNull(schema.registrationGrants.revokedAt),
      ))
      .returning({ id: schema.registrationGrants.id });
    return rows.length > 0;
  });
}
