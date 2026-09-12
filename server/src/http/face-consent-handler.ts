/**
 * 顔認証の同意 API の HTTP 境界。
 *
 * 扱うのは同意文・同意の記録・撤回・同意記録の配布だけで、テンプレートと写真は
 * Cernere に存在しない (spec/feature/face-consent-and-revocation.md)。
 * ここでは「誰の token か」「どの scope か」「入力形式」だけを見て、保存境界は
 * face-consent-store に閉じる。
 */

import { z } from "zod";
import { AppError } from "../error.js";
import { recordFaceAudit } from "../logging/face-audit.js";
import { requireFaceReviewer } from "../identity/face-consent-guard.js";
import {
  createFaceConsent,
  faceConsentPolicy,
  listFaceConsents,
  listOwnFaceConsents,
  revokeFaceConsents,
} from "../identity/face-consent-store.js";
import { isFaceRevocationReason } from "../identity/face-revocation-store.js";
import {
  FACE_CONSENT_READ_SCOPE,
  FACE_CONSENT_REVOKE_SCOPE,
  currentUser,
} from "./face-identity-auth.js";
import { requireServiceScope, type ServiceScopePrincipal } from "./service-scope-auth.js";

export interface FaceConsentRouteResult { status: string; data: unknown }

const uuidSchema = z.string().uuid();
const querySchema = z.object({ facilityId: uuidSchema.optional() }).strict();
const consentSchema = z.object({
  policyVersion: z.string().trim().min(1).max(128),
  facilityId: uuidSchema,
}).strict();
/**
 * kiosk 由来の撤回。`revokedBy` は「誰の立会いで消したか」で、認証主体とは別。
 * reason を省略した場合は本人撤回 (withdrawn) として扱う。
 */
const revokeSchema = z.object({
  userId: uuidSchema,
  facilityId: uuidSchema,
  revokedBy: uuidSchema,
  reason: z.string().trim().min(1).max(64).optional(),
}).strict();

function parse(body: string): unknown {
  try { return JSON.parse(body || "{}"); }
  catch { throw AppError.badRequest("Invalid JSON"); }
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.badRequest("Invalid face consent request");
  return result.data;
}

function parseQuery(query: string): z.infer<typeof querySchema> {
  return validate(querySchema, Object.fromEntries(new URLSearchParams(query)));
}

function auditActor(principal: ServiceScopePrincipal): { actorUserId: string; actorServiceId?: string } {
  return {
    actorUserId: principal.actorUserId,
    ...(principal.kind === "tool" ? { actorServiceId: principal.subject } : {}),
  };
}

async function handleSelfRevoke(authHeader: string, facilityId?: string): Promise<FaceConsentRouteResult> {
  const userId = await currentUser(authHeader);
  const result = await revokeFaceConsents(userId, facilityId, "withdrawn");
  await recordFaceAudit({
    action: "identity.face_consent.revoke",
    actorUserId: userId,
    targetUserId: userId,
    ...(facilityId ? { facilityId } : {}),
    reason: "withdrawn",
  });
  return { status: "200 OK", data: result };
}

async function handleServiceRevoke(body: string, authHeader: string): Promise<FaceConsentRouteResult> {
  const principal = await requireServiceScope(authHeader, FACE_CONSENT_REVOKE_SCOPE);
  const input = validate(revokeSchema, parse(body));
  const reason = input.reason ?? "withdrawn";
  // 失効指示の理由は Ostiarius の削除判断に入るので、契約上の語彙だけを通す。
  if (!isFaceRevocationReason(reason)) throw AppError.badRequest("Unsupported revocation reason");
  // 立会い職員として申告された user が、その施設で実際に無効化を指示できるかを確認する
  // (申告だけで他施設の登録を消させない)。
  await requireFaceReviewer(input.revokedBy, input.facilityId);
  const result = await revokeFaceConsents(input.userId, input.facilityId, reason);
  await recordFaceAudit({
    action: "identity.face_consent.revoke",
    ...auditActor(principal),
    delegatedUserId: input.revokedBy,
    targetUserId: input.userId,
    facilityId: input.facilityId,
    reason,
  });
  return { status: "200 OK", data: result };
}

async function handleListConsents(authHeader: string, facilityId?: string): Promise<FaceConsentRouteResult> {
  const principal = await requireServiceScope(authHeader, FACE_CONSENT_READ_SCOPE);
  if (!facilityId) throw AppError.badRequest("facilityId is required");
  const consents = await listFaceConsents(facilityId);
  await recordFaceAudit({
    action: "identity.face_consent.read",
    ...auditActor(principal),
    targetUserId: principal.actorUserId,
    facilityId,
  });
  return { status: "200 OK", data: { consents } };
}

export async function handleFaceConsentRoute(
  method: string,
  path: string,
  body: string,
  authHeader: string,
  query: string,
): Promise<FaceConsentRouteResult> {
  const { facilityId } = parseQuery(query);

  if (method === "GET" && path === "policy") return { status: "200 OK", data: faceConsentPolicy };

  if (method === "POST" && path === "consent") {
    const userId = await currentUser(authHeader);
    const input = validate(consentSchema, parse(body));
    const created = await createFaceConsent(userId, input.policyVersion, input.facilityId);
    await recordFaceAudit({
      action: "identity.face_consent.create",
      actorUserId: userId,
      targetUserId: userId,
      facilityId: input.facilityId,
      reason: input.policyVersion,
    });
    return { status: "201 Created", data: created };
  }

  if (method === "DELETE" && path === "consent") return handleSelfRevoke(authHeader, facilityId);

  if (method === "GET" && path === "status") {
    return { status: "200 OK", data: await listOwnFaceConsents(await currentUser(authHeader)) };
  }

  if (method === "POST" && path === "consent/revoke") return handleServiceRevoke(body, authHeader);

  if (method === "GET" && path === "consents") return handleListConsents(authHeader, facilityId);

  throw AppError.notFound("Unknown face consent route");
}
