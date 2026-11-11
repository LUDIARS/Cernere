/**
 * V.O.B から登録した人を V.O.B 組織に入れる (spec/feature/vob-discord-registration.md §1・§6)。
 *   - 自動許可の登録: signup と同じトランザクションで入れる。
 *   - 許可待ちの登録: 管理者が許可したとき (decideAccess の approve) に、同じトランザクションで入れる。
 * 既に入っていれば何もしない (onConflictDoNothing)。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import type { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Inserter = Pick<Tx, "insert">;

export interface ApprovedUserOrigin {
  id: string;
  registrationOrigin: string | null;
  registrationPlaceId: string | null;
}

export async function joinVobOrganization(tx: Inserter, organizationId: string, userId: string, now: Date): Promise<void> {
  await tx.insert(schema.organizationMembers).values({ organizationId, userId, role: "member", joinedAt: now })
    .onConflictDoNothing();
}

/** 許可した相手が V.O.B (Discord) からの登録なら V.O.B 組織に入れる。入れたら true。 */
export async function joinVobOrganizationOnApproval(tx: Inserter, target: ApprovedUserOrigin, now: Date): Promise<boolean> {
  if (target.registrationOrigin !== "discord_vob" || !target.registrationPlaceId) return false;
  await joinVobOrganization(tx, target.registrationPlaceId, target.id, now);
  return true;
}
