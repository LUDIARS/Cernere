/**
 * vob_registration_tokens の永続化 (migration 081)。
 * - トークンは 32 byte 乱数 base64url。平文は Discord の応答だけで返し、DB には SHA-256 を置く。
 * - 同じ Discord ID で新しく発行すると、その ID の未消費トークンは失効させる (最後の 1 本だけ有効)。
 * - 消費は条件付き UPDATE で一度だけ。期限切れの行は 1 日後に回収する。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import crypto from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db as defaultDb } from "../db/connection.js";
import { vobRegistrationTokens } from "../db/schema.js";
import type { VobTokenRow } from "./vob-token-state.js";

export const VOB_TOKEN_TTL_MS = 30 * 60_000;
export const VOB_TOKEN_RETENTION_MS = 24 * 60 * 60_000;

type Database = typeof defaultDb;
type Writer = Pick<Database, "update">;

export function hashVobToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface IssueVobTokenInput {
  discordUserId: string;
  discordUsername: string | null;
  guildJoinedAt: Date | null;
  organizationId: string;
  /** サーバー参加から日が浅い (approval-window.ts)。このトークンでの登録は許可待ちになる */
  requiresApproval: boolean;
}

export interface IssuedVobToken { token: string; expiresAt: Date }

export async function issueVobToken(input: IssueVobTokenInput, now = new Date(), database: Database = defaultDb,
  random: (size: number) => Buffer = crypto.randomBytes): Promise<IssuedVobToken> {
  const token = random(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + VOB_TOKEN_TTL_MS);
  await database.transaction(async (tx) => {
    await tx.update(vobRegistrationTokens).set({ revokedAt: now }).where(and(
      eq(vobRegistrationTokens.discordUserId, input.discordUserId),
      isNull(vobRegistrationTokens.consumedAt),
      isNull(vobRegistrationTokens.revokedAt),
    ));
    await tx.insert(vobRegistrationTokens).values({
      id: crypto.randomUUID(),
      tokenHash: hashVobToken(token),
      discordUserId: input.discordUserId,
      discordUsername: input.discordUsername,
      guildJoinedAt: input.guildJoinedAt,
      organizationId: input.organizationId,
      requiresApproval: input.requiresApproval,
      expiresAt,
      createdAt: now,
    });
  });
  return { token, expiresAt };
}

export async function readVobToken(token: string, database: Pick<Database, "select"> = defaultDb): Promise<VobTokenRow | null> {
  const row = (await database.select({
    id: vobRegistrationTokens.id,
    discordUserId: vobRegistrationTokens.discordUserId,
    discordUsername: vobRegistrationTokens.discordUsername,
    organizationId: vobRegistrationTokens.organizationId,
    guildJoinedAt: vobRegistrationTokens.guildJoinedAt,
    expiresAt: vobRegistrationTokens.expiresAt,
    consumedAt: vobRegistrationTokens.consumedAt,
    revokedAt: vobRegistrationTokens.revokedAt,
    requiresApproval: vobRegistrationTokens.requiresApproval,
  }).from(vobRegistrationTokens).where(eq(vobRegistrationTokens.tokenHash, hashVobToken(token))).limit(1))[0];
  return row ?? null;
}

/** 期限内・未消費・未失効の行を消費する。並行した 2 つ目の signup は false。 */
export async function consumeVobToken(tokenId: string, userId: string, now: Date, writer: Writer): Promise<boolean> {
  const rows = await writer.update(vobRegistrationTokens)
    .set({ consumedAt: now, consumedByUserId: userId })
    .where(and(
      eq(vobRegistrationTokens.id, tokenId),
      isNull(vobRegistrationTokens.consumedAt),
      isNull(vobRegistrationTokens.revokedAt),
      gt(vobRegistrationTokens.expiresAt, now),
    ))
    .returning({ id: vobRegistrationTokens.id });
  return rows.length > 0;
}

/** 期限から 1 日を過ぎた行を消す (消費済みの行は審査表示のため残す)。 */
export async function sweepVobTokens(now = new Date(), database: Database = defaultDb): Promise<number> {
  const cutoff = new Date(now.getTime() - VOB_TOKEN_RETENTION_MS);
  const rows = await database.delete(vobRegistrationTokens)
    .where(and(lt(vobRegistrationTokens.expiresAt, cutoff), isNull(vobRegistrationTokens.consumedAt)))
    .returning({ id: vobRegistrationTokens.id });
  return rows.length;
}
