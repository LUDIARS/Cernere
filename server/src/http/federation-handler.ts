/**
 * アカウント連携の HTTP (`POST /api/federation/:action`)。
 * spec/plan/2026-10-15-account-federation-design.md §4。
 *
 * 未ログインで呼べるのは device 側 (新しい端末 B) の 3 つだけ: request-create / invite-claim / request-status。
 * いずれも IP 単位のレート制限をかける。承認・連携の変更は本人のパスキーの action proof を必須にする。
 */

import { z } from "zod";

import { actionProofStore, httpActionBinding } from "../auth/action-proof.js";
import type { ProtectedAction } from "../auth/action-policy.js";
import { config } from "../config.js";
import { db } from "../db/connection.js";
import { AppError } from "../error.js";
import { joinRequestStore } from "../federation/join-request-instance.js";
import { joinRequestUrl, type ApproverView } from "../federation/join-request.js";
import { listServiceUsage, type ServiceUsage } from "../federation/service-usage.js";
import { describeFederation, joinFederation, removeFederationMember, setFederationPrimary } from "../federation/store.js";
import { summarizeUserAgent } from "../lib/user-agent-summary.js";
import { checkRateLimit } from "../redis.js";
import { requireUserId } from "./bearer-user.js";

export interface FederationRequestCtx {
  ip?: string;
  userAgent?: string;
}

interface RouteResult { status: string; data: unknown }

const tokenSchema = z.object({ token: z.string().min(16).max(512) }).strict();
const requestIdSchema = z.object({ requestId: z.string().uuid() }).strict();
const deviceSchema = z.object({ requestId: z.string().uuid(), deviceSecret: z.string().min(16).max(512) }).strict();
const approveSchema = z.object({ requestId: z.string().uuid(), code: z.string().regex(/^\d{4}$/) }).strict();
const memberChangeSchema = z.object({ userId: z.string().uuid(), expectedRevision: z.number().int().min(0) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw AppError.badRequest(message);
  return parsed.data;
}

/** device 側はログインしていなくてもよい。ヘッダがあれば検証し、既存アカウント (§4.2) として扱う。 */
async function optionalUserId(authHeader: string): Promise<string | null> {
  if (!authHeader.trim()) return null;
  return (await requireUserId(authHeader)).id;
}

async function consumeProof(authHeader: string, proof: string, action: ProtectedAction, resource: string): Promise<string> {
  const { id: userId, token } = await requireUserId(authHeader);
  await actionProofStore.consume(proof, { userId, binding: httpActionBinding(token), action, resource });
  return userId;
}

/** 承認画面用: 端末の概略と、既存アカウントならそのアカウントで使っていたサービス (§4.2 の警告)。 */
async function approverPayload(view: ApproverView): Promise<ApproverView & { joinerServices: ServiceUsage[]; approvalResource: string }> {
  const joinerServices = view.kind === "existing_account" && view.joinerUserId ? await listServiceUsage(view.joinerUserId) : [];
  // 加わるアカウントの id は承認者へ返さない (サービス名だけを見せる)。
  return { ...view, joinerUserId: null, joinerServices, approvalResource: view.requestId };
}

export async function handleFederationRoute(
  action: string,
  body: unknown,
  authHeader: string,
  actionProof: string,
  ctx: FederationRequestCtx,
): Promise<RouteResult> {
  const ip = ctx.ip ?? "anon";
  const device = summarizeUserAgent(ctx.userAgent);
  switch (action) {
    // ── device 側 (B: 未ログイン可 / C: ログイン済み) ──
    case "request-create": {
      await checkRateLimit(`federation-request:${ip}`, 10, 600);
      await checkRateLimit("federation-request:global", 600, 600);
      const joinerUserId = await optionalUserId(authHeader);
      const created = await joinRequestStore.createDeviceRequest({ joinerUserId, device });
      return { status: "200 OK", data: {
        requestId: created.requestId, code: created.code, deviceSecret: created.deviceSecret, expiresIn: created.expiresIn,
        approveUrl: joinRequestUrl(config.frontendUrl, "device", created.token),
      } };
    }
    case "invite-claim": {
      await checkRateLimit(`federation-claim:${ip}`, 30, 600);
      const { token } = parse(tokenSchema, body, "token is required");
      const joinerUserId = await optionalUserId(authHeader);
      return { status: "200 OK", data: await joinRequestStore.claimAsDevice(token, { joinerUserId, device }) };
    }
    case "request-status": {
      await checkRateLimit(`federation-status:${ip}`, 600, 600);
      const p = parse(deviceSchema, body, "requestId and deviceSecret are required");
      return { status: "200 OK", data: await joinRequestStore.deviceStatus(p.requestId, p.deviceSecret) };
    }
    case "my-services": {
      const { id } = await requireUserId(authHeader);
      return { status: "200 OK", data: { services: await listServiceUsage(id) } };
    }
    case "join-complete": {
      // 既存アカウント C が承認済みの要求で連携に加わる (C 側でもパスキーで本人確認、§4.2)。
      const p = parse(deviceSchema, body, "requestId and deviceSecret are required");
      const userId = await consumeProof(authHeader, actionProof, "federation.join", p.requestId);
      const record = await joinRequestStore.beginCompletion(p.requestId, p.deviceSecret, userId);
      try {
        await db.transaction((tx) => joinFederation(tx, {
          approverUserId: record.approverUserId!, joinerUserId: userId, via: "qr_existing_account", device: record.device ?? undefined,
        }));
      } catch (error) {
        await joinRequestStore.abortCompletion(p.requestId);
        throw error;
      }
      await joinRequestStore.finishCompletion(record);
      return { status: "200 OK", data: await describeFederation(userId) };
    }

    // ── approver 側 (A: ログイン済み) ──
    case "invite-create": {
      const { id } = await requireUserId(authHeader);
      await checkRateLimit(`federation-invite:${id}`, 10, 600);
      const invite = await joinRequestStore.createInvite(id);
      return { status: "200 OK", data: {
        requestId: invite.requestId, expiresIn: invite.expiresIn,
        joinUrl: joinRequestUrl(config.frontendUrl, "approver", invite.token),
      } };
    }
    case "request-claim": {
      const { id } = await requireUserId(authHeader);
      await checkRateLimit(`federation-claim:${id}`, 30, 600);
      const { token } = parse(tokenSchema, body, "token is required");
      return { status: "200 OK", data: await approverPayload(await joinRequestStore.claimAsApprover(token, id)) };
    }
    case "request-describe": {
      const { id } = await requireUserId(authHeader);
      const { requestId } = parse(requestIdSchema, body, "requestId is required");
      return { status: "200 OK", data: await approverPayload(await joinRequestStore.describeForApprover(requestId, id)) };
    }
    case "request-approve": {
      const p = parse(approveSchema, body, "requestId and the 4-digit number shown on the other device are required");
      const userId = await consumeProof(authHeader, actionProof, "federation.approve", p.requestId);
      await checkRateLimit(`federation-approve:${p.requestId}`, 10, 600);
      return { status: "200 OK", data: await approverPayload(await joinRequestStore.approve(p.requestId, userId, p.code)) };
    }

    // ── 設定「アカウントの連携」(§4.3) ──
    case "describe": {
      const { id } = await requireUserId(authHeader);
      return { status: "200 OK", data: await describeFederation(id) };
    }
    case "set-primary": {
      const p = parse(memberChangeSchema, body, "userId and expectedRevision are required");
      const { id } = await requireUserId(authHeader);
      const view = await describeFederation(id);
      if (!view.federationId) throw AppError.notFound("This account is not federated");
      await consumeProof(authHeader, actionProof, "federation.set_primary", view.federationId);
      return { status: "200 OK", data: await setFederationPrimary(id, p.userId, p.expectedRevision) };
    }
    case "remove": {
      const p = parse(memberChangeSchema, body, "userId and expectedRevision are required");
      const { id } = await requireUserId(authHeader);
      const view = await describeFederation(id);
      if (!view.federationId) throw AppError.notFound("This account is not federated");
      await consumeProof(authHeader, actionProof, "federation.remove", `${view.federationId}:${p.userId}`);
      return { status: "200 OK", data: await removeFederationMember(id, p.userId, p.expectedRevision) };
    }
    default:
      return { status: "404 Not Found", data: { error: `Unknown federation action: ${action}` } };
  }
}
