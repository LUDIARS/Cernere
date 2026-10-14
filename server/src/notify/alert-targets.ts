/**
 * ログイン通知の宛先 (SPEC-LOGIN-ALERT)。
 *
 * 宛先はアカウント連携で本人が紐付けた先に限る (Discord の discord_id、Google 連携で
 * Google が検証したアドレス)。有効化は「試験通知の確認番号を Cr の画面で入れる」までで、
 * 届くと確かめられた宛先だけに配送する。宛先には何の権限も持たせない (通知先を
 * 乗っ取られても Cr の操作はできない)。宛先の追加・削除は変更前の宛先にも知らせる。
 */

import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { recordSecurityEvent } from "./security-events.js";
import { deliverVerificationCode } from "./alert-delivery.js";

export type AlertChannel = "discord" | "google";

export const VERIFICATION_TTL_MS = 10 * 60 * 1000;
export const VERIFICATION_MAX_ATTEMPTS = 5;

function digestCode(targetId: string, code: string): string {
  return crypto.createHash("sha256").update(`${targetId}:${code}`).digest("base64url");
}

function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** 連携済みの宛先アドレス。未連携なら null。 */
async function linkedAddress(userId: string, channel: AlertChannel): Promise<string | null> {
  const user = (await db.select({
    discordId: schema.users.discordId,
    googleVerifiedEmail: schema.users.googleVerifiedEmail,
  }).from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw AppError.unauthorized("User not found");
  return channel === "discord" ? user.discordId : user.googleVerifiedEmail;
}

export interface AlertTargetView {
  channel: AlertChannel;
  verified: boolean;
  degraded: boolean;
}

export async function listAlertTargets(userId: string): Promise<{ targets: AlertTargetView[]; linked: Record<AlertChannel, boolean> }> {
  const rows = await db.select().from(schema.loginAlertTargets).where(and(
    eq(schema.loginAlertTargets.userId, userId),
    isNull(schema.loginAlertTargets.removedAt),
  ));
  return {
    targets: rows.map((r) => ({ channel: r.channel as AlertChannel, verified: Boolean(r.verifiedAt), degraded: Boolean(r.degradedAt) })),
    linked: {
      discord: Boolean(await linkedAddress(userId, "discord")),
      google: Boolean(await linkedAddress(userId, "google")),
    },
  };
}

/**
 * 宛先を追加し (または既存の未確認宛先を作り直し)、試験通知で確認番号を送る。
 * 呼び出し側で fresh action proof (login_alert.manage) を確認済みであること。
 */
export async function startAlertTarget(userId: string, channel: AlertChannel): Promise<{ sent: true }> {
  const address = await linkedAddress(userId, channel);
  if (!address) throw AppError.conflict(`Link your ${channel === "discord" ? "Discord" : "Google"} account first`);
  const code = newCode();
  const now = new Date();
  const targetId = await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for("update");
    const existing = (await tx.select().from(schema.loginAlertTargets).where(and(
      eq(schema.loginAlertTargets.userId, userId),
      eq(schema.loginAlertTargets.channel, channel),
      isNull(schema.loginAlertTargets.removedAt),
    )).for("update"))[0];
    if (existing?.verifiedAt && existing.address === address) throw AppError.conflict("This notification target is already active");
    if (existing) {
      await tx.update(schema.loginAlertTargets).set({ removedAt: now }).where(eq(schema.loginAlertTargets.id, existing.id));
    }
    const id = crypto.randomUUID();
    await tx.insert(schema.loginAlertTargets).values({
      id,
      userId,
      channel,
      address,
      verificationDigest: digestCode(id, code),
      verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    });
    return id;
  });
  // 送信失敗は利用者に返す (届かない宛先を「設定済み」に見せない)。
  try {
    await deliverVerificationCode(channel, address, code);
  } catch (err) {
    await db.update(schema.loginAlertTargets).set({ removedAt: new Date() }).where(eq(schema.loginAlertTargets.id, targetId));
    throw AppError.withCode(502, "alert_target_unreachable",
      err instanceof Error ? err.message : "The confirmation message could not be delivered");
  }
  return { sent: true };
}

/** 試験通知の確認番号を照合して宛先を有効化する。番号を知っていること自体が到達の証拠。 */
export async function verifyAlertTarget(userId: string, channel: AlertChannel, code: string): Promise<{ verified: true }> {
  if (!/^\d{6}$/.test(code)) throw AppError.badRequest("Enter the 6-digit code");
  await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for("update");
    const target = (await tx.select().from(schema.loginAlertTargets).where(and(
      eq(schema.loginAlertTargets.userId, userId),
      eq(schema.loginAlertTargets.channel, channel),
      isNull(schema.loginAlertTargets.removedAt),
    )).for("update"))[0];
    if (!target || target.verifiedAt || !target.verificationDigest || !target.verificationExpiresAt
      || target.verificationExpiresAt.getTime() <= Date.now() || target.verificationAttempts >= VERIFICATION_MAX_ATTEMPTS) {
      throw AppError.unauthorized("The code has expired; send a new one");
    }
    const expected = Buffer.from(target.verificationDigest);
    const actual = Buffer.from(digestCode(target.id, code));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      await tx.update(schema.loginAlertTargets).set({ verificationAttempts: target.verificationAttempts + 1 })
        .where(eq(schema.loginAlertTargets.id, target.id));
      throw AppError.unauthorized("The code does not match");
    }
    // 新しい宛先が有効になったことを、有効化より前の宛先にも知らせる。
    await recordSecurityEvent(tx, userId, "alert_target.added", { channel });
    await tx.update(schema.loginAlertTargets).set({
      verifiedAt: new Date(),
      verificationDigest: null,
      verificationExpiresAt: null,
      degradedAt: null,
    }).where(eq(schema.loginAlertTargets.id, target.id));
  });
  return { verified: true };
}

type Database = Pick<typeof db, "select" | "insert" | "update">;

/**
 * 宛先を外す。外す前に出来事を記録するので、外される宛先にも最後の通知が届く。
 * 連携解除 (unlink) からも同じトランザクションで呼ぶ。
 */
export async function removeAlertTarget(database: Database, userId: string, channel: AlertChannel): Promise<boolean> {
  const target = (await database.select().from(schema.loginAlertTargets).where(and(
    eq(schema.loginAlertTargets.userId, userId),
    eq(schema.loginAlertTargets.channel, channel),
    isNull(schema.loginAlertTargets.removedAt),
  )).limit(1))[0];
  if (!target) return false;
  if (target.verifiedAt) await recordSecurityEvent(database, userId, "alert_target.removed", { channel });
  await database.update(schema.loginAlertTargets).set({ removedAt: new Date() }).where(eq(schema.loginAlertTargets.id, target.id));
  return true;
}

/** 恒久的な配送失敗 (Discord の DM 拒否など)。画面に「届いていない」を出すために印を付ける。 */
export async function markAlertTargetDegraded(channel: AlertChannel, address: string): Promise<void> {
  await db.update(schema.loginAlertTargets).set({ degradedAt: new Date() }).where(and(
    eq(schema.loginAlertTargets.channel, channel),
    eq(schema.loginAlertTargets.address, address),
    isNull(schema.loginAlertTargets.removedAt),
  ));
}
