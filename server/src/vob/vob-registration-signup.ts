/**
 * パスキー signup (signup-finish / composite-signup-finish) の vobToken 分岐
 * (spec/feature/vob-discord-registration.md §1)。
 *
 *   precheck (ceremony 消費前): トークンが使えるか + V.O.B サーバーに今も参加しているか。だめなら 422
 *   apply (user 作成と同じトランザクション): トークンを消費し、Discord を自動連携し、
 *     active・discord_vob・V.O.B 組織の member で作る。2 つ目の消費や別アカウントに連携済みの Discord ID は 422
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { fetchGuildMember } from "./discord-guild.js";
import { readVobConfig } from "./vob-config.js";
import { vobTokenOutcome } from "./vob-token-state.js";
import { consumeVobToken, readVobToken } from "./vob-token-store.js";

export const VOB_TOKEN_INVALID = "vob_token_invalid";
export const VOB_REGISTRATION_REASON = "vob_discord_registration";

type SignupTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function vobTokenInvalid(): AppError {
  return AppError.withCode(422, VOB_TOKEN_INVALID, VOB_TOKEN_INVALID);
}

export interface VobSignupPlan {
  tokenId: string;
  discordUserId: string;
  discordUsername: string | null;
  organizationId: string;
}

export interface VobPrecheckDeps {
  read: typeof readVobToken;
  stillMember(discordUserId: string): Promise<boolean>;
  linkedElsewhere(discordUserId: string): Promise<boolean>;
}

function defaultDeps(): VobPrecheckDeps {
  return {
    read: readVobToken,
    async stillMember(discordUserId) {
      const config = readVobConfig();
      if (!config) return false;
      return (await fetchGuildMember(config.botToken, config.guildId, discordUserId)) !== null;
    },
    async linkedElsewhere(discordUserId) {
      const rows = await db.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.discordId, discordUserId)).limit(1);
      return rows.length > 0;
    },
  };
}

/** ceremony を消費する前の確認。機能が無効・トークン無効・サーバーを抜けた・連携済みは 422。 */
export async function precheckVobSignup(token: string, now = new Date(), deps: VobPrecheckDeps = defaultDeps()): Promise<VobSignupPlan> {
  if (!readVobConfig()) throw vobTokenInvalid();
  const outcome = vobTokenOutcome(await deps.read(token), now);
  if (outcome.kind === "invalid") throw vobTokenInvalid();
  // 完了時にもう一度確かめる: 発行後にサーバーを抜けた人・別経路で連携済みの人は通さない。
  let member = false;
  try { member = await deps.stillMember(outcome.discordUserId); } catch { member = false; }
  if (!member || await deps.linkedElsewhere(outcome.discordUserId)) throw vobTokenInvalid();
  return {
    tokenId: outcome.tokenId,
    discordUserId: outcome.discordUserId,
    discordUsername: outcome.discordUsername,
    organizationId: outcome.organizationId,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** user 行の挿入直後、同じトランザクションで呼ぶ。 */
export async function applyVobSignup(tx: SignupTx, userId: string, plan: VobSignupPlan, now: Date): Promise<{ organizationId: string }> {
  if (!(await consumeVobToken(plan.tokenId, userId, now, tx))) throw vobTokenInvalid();
  try {
    await tx.update(schema.users).set({
      discordId: plan.discordUserId,
      discordUsername: plan.discordUsername,
      registrationOrigin: "discord_vob",
      registrationPlaceId: plan.organizationId,
      accessStatus: "active",
      accessRevision: 1,
      accessChangedAt: now,
    }).where(eq(schema.users.id, userId));
  } catch (err) {
    // 並行して同じ Discord ID が別アカウントに連携された。1 Discord ID = 1 アカウント。
    if (isUniqueViolation(err)) throw vobTokenInvalid();
    throw err;
  }
  await tx.insert(schema.organizationMembers).values({ organizationId: plan.organizationId, userId, role: "member", joinedAt: now })
    .onConflictDoNothing();
  await tx.insert(schema.accessDecisions).values({
    id: crypto.randomUUID(), actorUserId: null, targetUserId: userId, expectedRevision: 0,
    beforeStatus: "pending", afterStatus: "active", reasonCode: VOB_REGISTRATION_REASON, requestId: null, createdAt: now,
  });
  return { organizationId: plan.organizationId };
}
