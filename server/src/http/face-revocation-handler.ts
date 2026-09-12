/**
 * 失効指示 API の HTTP 境界 (GET /api/identity/face-revocations)。
 *
 * Ostiarius が 15 分ごと (+ 職員の即時 sync) に pull し、該当 user の
 * テンプレート・写真・同意の写しを施設内で物理削除する。
 * 応答に生体情報は含まれない (userId / facilityId / reason / at のみ)。
 */

import { z } from "zod";
import { AppError } from "../error.js";
import { recordFaceAudit } from "../logging/face-audit.js";
import { listFaceRevocations } from "../identity/face-revocation-store.js";
import { FACE_REVOCATION_READ_SCOPE } from "./face-identity-auth.js";
import { requireServiceScope } from "./service-scope-auth.js";

export interface FaceRevocationRouteResult { status: string; data: unknown }

const querySchema = z.object({
  facilityId: z.string().uuid(),
  since: z.string().trim().min(1).max(64).optional(),
}).strict();

export async function handleFaceRevocationRoute(
  method: string,
  authHeader: string,
  query: string,
): Promise<FaceRevocationRouteResult> {
  if (method !== "GET") throw AppError.notFound("Unknown face revocation route");
  const principal = await requireServiceScope(authHeader, FACE_REVOCATION_READ_SCOPE);
  // facilityId は必須。施設を指定しない全量取得の口は作らない (配布範囲を施設に限る)。
  const parsed = querySchema.safeParse(Object.fromEntries(new URLSearchParams(query)));
  if (!parsed.success) throw AppError.badRequest("facilityId is required");
  const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
  if (since && Number.isNaN(since.getTime())) throw AppError.badRequest("since must be an ISO timestamp");

  const revocations = await listFaceRevocations(parsed.data.facilityId, since);
  await recordFaceAudit({
    action: "identity.face_revocation.read",
    actorUserId: principal.actorUserId,
    ...(principal.kind === "tool" ? { actorServiceId: principal.subject } : {}),
    targetUserId: principal.actorUserId,
    facilityId: parsed.data.facilityId,
  });
  return { status: "200 OK", data: { revocations } };
}
