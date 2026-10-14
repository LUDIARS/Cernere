/**
 * リカバリー QR の REST 入口 (SPEC-RECOVERY-QR / SPEC-RECOVERY-QR-USE)。
 *
 *   recovery-code-issue     bearer。初回は作成/回復確定から 15 分以内なら proof 不要、以降は proof 必須
 *   recovery-code-status    bearer。有効なコードの有無と保留中の回復
 *   recovery-code-begin     未認証。QR のコードを照合して新しいキーの登録を始める
 *   recovery-code-finish    未認証。新しいキーを保留し、24 時間の回復待機に入る
 *   recovery-request-cancel bearer + proof。保留中の回復を旧キーで取り消す
 *   recovery-confirm-begin / recovery-confirm-finish  未認証。待機後に新しいキーで確定してログイン
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { checkRateLimit } from "../redis.js";
import { actionProofStore, httpActionBinding } from "../auth/action-proof.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { completedAuthentication } from "../lib/authentication-evidence.js";
import {
  RECOVERY_CODE_GRACE_MS,
  hasActiveRecoveryCode,
  issueRecoveryCode,
  loadRecoveryCodeKey,
} from "../auth/recovery-code.js";
import {
  beginRecoveryConfirmation,
  beginRecoveryWithCode,
  cancelRecoveryRequest,
  completedRecoveryWithin,
  confirmRecovery,
  finishRecoveryWithCode,
  getOpenRecoveryRequest,
} from "../auth/recovery-request.js";
import { recordSecurityEvent } from "../notify/security-events.js";
import { requireUserId } from "./bearer-user.js";
import { sessionRegistry } from "../ws/session-registry.js";

interface RouteResult { status: string; data: unknown }
interface RecoveryCtx { ip?: string; userAgent?: string }

export const RECOVERY_CODE_ACTIONS = new Set([
  "recovery-code-issue",
  "recovery-code-status",
  "recovery-code-begin",
  "recovery-code-finish",
  "recovery-request-cancel",
  "recovery-confirm-begin",
  "recovery-confirm-finish",
]);

export async function handleRecoveryCodeRoute(
  action: string,
  body: Record<string, unknown>,
  authHeader: string,
  actionProof: string,
  ctx: RecoveryCtx,
): Promise<RouteResult> {
  switch (action) {
    case "recovery-code-issue": return issue(authHeader, actionProof);
    case "recovery-code-status": return status(authHeader);
    case "recovery-code-begin": return begin(body, ctx);
    case "recovery-code-finish": return finish(body, ctx);
    case "recovery-request-cancel": return cancel(body, authHeader, actionProof);
    case "recovery-confirm-begin": return confirmBegin(ctx);
    case "recovery-confirm-finish": return confirmFinish(body, ctx);
    default: return { status: "404 Not Found", data: { error: `Unknown recovery action: ${action}` } };
  }
}

/** 匿名で叩ける入口の予算。IP ごとと全体の両方で抑え、userId 単位の予算は持たない (第三者に本人の回復枠を潰させない)。 */
async function limitAnonymous(scope: string, ctx: RecoveryCtx): Promise<void> {
  await checkRateLimit(`${scope}:ip:${ctx.ip ?? "anon"}`, 15, 60);
  await checkRateLimit(`${scope}:global`, 600, 60);
}

/** proof 無しで初回のコードを出してよいか: 有効なコードが無く、作成直後か回復確定直後。 */
async function inIssueGrace(userId: string): Promise<boolean> {
  if (await hasActiveRecoveryCode(userId)) return false;
  const user = (await db.select({ createdAt: schema.users.createdAt }).from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) return false;
  return Date.now() - user.createdAt.getTime() < RECOVERY_CODE_GRACE_MS
    || await completedRecoveryWithin(userId, RECOVERY_CODE_GRACE_MS);
}

async function issue(authHeader: string, actionProof: string): Promise<RouteResult> {
  const { id: userId, token } = await requireUserId(authHeader);
  await checkRateLimit(`recovery-code-issue:${userId}`, 10, 3600);
  const grace = await inIssueGrace(userId);
  if (!grace) {
    await actionProofStore.consume(actionProof, {
      userId,
      binding: httpActionBinding(token),
      action: "recovery_code.issue",
      resource: userId,
    });
  }
  const key = loadRecoveryCodeKey();
  const issued = await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for("update");
    // 猶予の判定とコード発行の間に別タブで発行されていないかを、ロック下で確かめ直す。
    if (grace && await hasActiveRecoveryCode(userId, tx)) throw AppError.conflict("A recovery code already exists; reissue it from your profile");
    const result = await issueRecoveryCode(tx, userId, key);
    if (!grace) await recordSecurityEvent(tx, userId, "recovery.code_reissued");
    return result;
  });
  return { status: "201 Created", data: issued };
}

async function status(authHeader: string): Promise<RouteResult> {
  const { id: userId } = await requireUserId(authHeader);
  return {
    status: "200 OK",
    data: {
      hasActiveCode: await hasActiveRecoveryCode(userId),
      canIssueWithoutProof: await inIssueGrace(userId),
      pendingRecovery: await getOpenRecoveryRequest(userId),
    },
  };
}

const beginSchema = z.object({ code: z.string().min(1).max(256) }).strict();

async function begin(body: Record<string, unknown>, ctx: RecoveryCtx): Promise<RouteResult> {
  await limitAnonymous("recovery-code-begin", ctx);
  const parsed = beginSchema.safeParse(body);
  if (!parsed.success) throw AppError.unauthorized("Recovery code is invalid or can no longer be used");
  return { status: "200 OK", data: await beginRecoveryWithCode(parsed.data.code) };
}

async function finish(body: Record<string, unknown>, ctx: RecoveryCtx): Promise<RouteResult> {
  await limitAnonymous("recovery-code-finish", ctx);
  const ceremonyId = typeof body.ceremonyId === "string" ? body.ceremonyId : "";
  const response = body.response as RegistrationResponseJSON | undefined;
  if (!ceremonyId || !response) throw AppError.badRequest("ceremonyId and response are required");
  return { status: "202 Accepted", data: await finishRecoveryWithCode({ ceremonyId, response, userAgent: ctx.userAgent }) };
}

const cancelSchema = z.object({ requestId: z.string().uuid() }).strict();

async function cancel(body: Record<string, unknown>, authHeader: string, actionProof: string): Promise<RouteResult> {
  const { id: userId, token } = await requireUserId(authHeader);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) throw AppError.badRequest("requestId is required");
  // proof は passkeys の有効なキーでしか取れない。回復の新しいキーは候補のままなので取消に使えない。
  await actionProofStore.consume(actionProof, {
    userId,
    binding: httpActionBinding(token),
    action: "recovery_request.cancel",
    resource: parsed.data.requestId,
  });
  await cancelRecoveryRequest(userId, parsed.data.requestId);
  return { status: "200 OK", data: { cancelled: true } };
}

async function confirmBegin(ctx: RecoveryCtx): Promise<RouteResult> {
  await limitAnonymous("recovery-confirm-begin", ctx);
  return { status: "200 OK", data: await beginRecoveryConfirmation() };
}

async function confirmFinish(body: Record<string, unknown>, ctx: RecoveryCtx): Promise<RouteResult> {
  await limitAnonymous("recovery-confirm-finish", ctx);
  const confirmId = typeof body.confirmId === "string" ? body.confirmId : "";
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!confirmId || !response) throw AppError.badRequest("confirmId and response are required");
  const { user, verifiedAt } = await confirmRecovery(confirmId, response);
  // 旧端末の WS は epoch 不一致で操作できないが、開いたままのソケットも閉じる。
  sessionRegistry.closeUser(user.id, "Account recovered");

  // 新しいキーの assertion で確定したので、そのままログインさせる (epoch は確定で進んでいる)。
  const authentication = completedAuthentication("passkey", user.mfaRevision, verifiedAt);
  const { accessToken, refreshToken, authEpoch } = await generateTokenPair(user.id, user.role, authentication, { authEpoch: user.authEpoch });
  await db.insert(schema.refreshSessions).values({
    authEpoch,
    authentication,
    id: crypto.randomUUID(),
    userId: user.id,
    refreshToken: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
  });
  return {
    status: "200 OK",
    data: {
      recovered: true,
      user: {
        id: user.id,
        login: user.login,
        displayName: user.displayName || null,
        role: user.role,
        needsProfile: user.displayNameSource === "unset",
      },
      accessToken,
      refreshToken,
    },
  };
}
