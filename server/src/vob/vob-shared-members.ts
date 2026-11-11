/**
 * V.O.B から GLab への一部共有 (spec/feature/vob-discord-registration.md §5)。
 * GLab が見られるのは V.O.B での表示名・V.O.B 所属・Discord 名だけ。メール・顔・プロフィールは返さない。
 * 逆方向 (GLab → V.O.B) の口は作らない。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

export const VOB_AFFILIATION = "V.O.B";

export interface VobSharedMember {
  userId: string;
  displayName: string;
  affiliation: typeof VOB_AFFILIATION;
  discordUsername: string | null;
}

export function toSharedMember(row: { userId: string; displayName: string | null; discordUsername: string | null }): VobSharedMember {
  return { userId: row.userId, displayName: row.displayName ?? "", affiliation: VOB_AFFILIATION, discordUsername: row.discordUsername ?? null };
}

export async function listVobSharedMembers(organizationId: string): Promise<VobSharedMember[]> {
  const rows = await db.select({
    userId: schema.users.id,
    displayName: schema.users.displayName,
    discordUsername: schema.users.discordUsername,
  }).from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.organizationMembers.userId, schema.users.id))
    .where(eq(schema.organizationMembers.organizationId, organizationId));
  return rows.map(toSharedMember);
}
