/**
 * 顔写真 API の HTTP 境界。
 *
 * face-template-handler.ts (テンプレート契約) を肥大化させないため別ファイルに分ける。
 * ここでは「誰の token か」「どの scope か」「入力形式」だけを見て、保存境界と
 * 暗号は face-photo-store に閉じる。
 *
 * 写真バイト・埋め込みは戻り値としてのみ扱い、ログ・エラー文言へ載せない。
 */

import { z } from "zod";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { AppError } from "../error.js";
import { requireServiceScope, type ServiceScopePrincipal } from "./service-scope-auth.js";
import { parseMultipart, requireSingleFile } from "./multipart-form.js";
import { recordFaceAudit } from "../logging/face-audit.js";
import {
  deleteFacePhoto,
  promoteFaceTemplate,
  readFacePhoto,
  rejectFaceTemplate,
  saveFacePhoto,
} from "../identity/face-photo-store.js";

export const FACE_PHOTO_READ_SCOPE = "face-photo:read";
export const FACE_PHOTO_MANAGE_SCOPE = "face-photo:manage";

export interface FacePhotoRouteResult {
  status: string;
  /** JSON 応答。binary が入る場合は undefined。 */
  data?: unknown;
  /** 画像応答。private, no-store を付けて返す。 */
  binary?: { bytes: Buffer; contentType: string };
}

export interface FacePhotoRequest {
  method: string;
  /** 正規化済みの内部パス (例: "photo", "photo/me", "photo/:userId", "template/:userId/promote")。 */
  path: string;
  body: Buffer;
  contentType: string;
  authHeader: string;
  query: string;
}

const uuidSchema = z.string().uuid();
const querySchema = z.object({ facilityId: uuidSchema.optional() }).strict();
const serviceDeleteSchema = z.object({
  enrolledBy: uuidSchema,
  reason: z.string().trim().min(1).max(256),
}).strict();
const promoteSchema = z.object({
  enrolledBy: uuidSchema,
  facilityId: uuidSchema,
  mode: z.enum(["reenroll", "promote-photo"]).default("reenroll"),
}).strict();
const rejectSchema = z.object({
  enrolledBy: uuidSchema,
  facilityId: uuidSchema,
  reason: z.string().trim().min(1).max(256),
}).strict();

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.badRequest("Invalid face photo request");
  return result.data;
}

function parseJson(body: Buffer): unknown {
  try { return JSON.parse(body.toString("utf8") || "{}"); }
  catch { throw AppError.badRequest("Invalid JSON"); }
}

function currentUser(authHeader: string): string {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");
  const claims = verifyToken(token) as ReturnType<typeof verifyToken> & {
    owner?: unknown;
    tokenType?: unknown;
  };
  // user/tool/project が同じ HS256 鍵を使うため、署名だけで本人 token と判断しない。
  if (typeof claims.sub !== "string"
    || typeof claims.role !== "string"
    || claims.owner !== undefined
    || claims.tokenType !== undefined
    || !uuidSchema.safeParse(claims.sub).success) {
    throw AppError.unauthorized("Invalid user access token");
  }
  return claims.sub;
}

function requireFacilityId(query: string): string {
  const { facilityId } = validate(querySchema, Object.fromEntries(new URLSearchParams(query)));
  if (!facilityId) throw AppError.badRequest("facilityId is required");
  return facilityId;
}

function pathUserId(path: string, prefix: string, suffix = ""): string {
  const rest = path.slice(prefix.length);
  const raw = suffix ? rest.slice(0, rest.length - suffix.length) : rest;
  return validate(uuidSchema, raw);
}

function managementActor(
  principal: ServiceScopePrincipal,
  enrolledBy: string,
): { actorUserId: string; actorServiceId?: string } {
  // request body の職員 ID を認証主体から独立させると reviewer を偽装できる。
  if (principal.actorUserId !== enrolledBy) {
    throw AppError.forbidden("enrolledBy must match the authenticated actor");
  }
  return {
    actorUserId: principal.actorUserId,
    ...(principal.kind === "tool" ? { actorServiceId: principal.subject } : {}),
  };
}

async function handleSelfDelete(authHeader: string): Promise<FacePhotoRouteResult> {
  const userId = currentUser(authHeader);
  const removed = await deleteFacePhoto(userId, "user_deleted_photo");
  await recordFaceAudit({
    action: "identity.face_photo.delete",
    actorUserId: userId,
    targetUserId: userId,
    reason: "user_deleted_photo",
  });
  return { status: "200 OK", data: removed };
}

async function handleUpload(req: FacePhotoRequest): Promise<FacePhotoRouteResult> {
  const userId = currentUser(req.authHeader);
  const facilityId = requireFacilityId(req.query);
  const file = requireSingleFile(parseMultipart(req.body, req.contentType), "image");
  try {
    const saved = await saveFacePhoto({ userId, facilityId, image: file.bytes, mime: file.mime });
    await recordFaceAudit({
      action: "identity.face_photo.save",
      actorUserId: userId,
      targetUserId: userId,
      facilityId,
    });
    return { status: "201 Created", data: saved };
  } finally {
    // 受信バイトはハンドラを抜ける時点で残さない。
    file.bytes.fill(0);
  }
}

async function handleRead(
  userId: string,
  actor: { actorUserId?: string; actorServiceId?: string },
): Promise<FacePhotoRouteResult> {
  const photo = await readFacePhoto(userId);
  await recordFaceAudit({ action: "identity.face_photo.read", ...actor, targetUserId: userId });
  return { status: "200 OK", binary: { bytes: photo.bytes, contentType: photo.mime } };
}

export async function handleFacePhotoRoute(req: FacePhotoRequest): Promise<FacePhotoRouteResult> {
  // ── 生徒本人 ───────────────────────────────────────────
  if (req.method === "POST" && req.path === "photo") return handleUpload(req);

  if (req.method === "GET" && req.path === "photo/me") {
    const userId = currentUser(req.authHeader);
    return handleRead(userId, { actorUserId: userId });
  }

  if (req.method === "DELETE" && (req.path === "photo" || req.path === "photo/me")) {
    return handleSelfDelete(req.authHeader);
  }

  // ── service (scope 必須) ──────────────────────────────
  if (req.method === "GET" && req.path.startsWith("photo/")) {
    const principal = await requireServiceScope(req.authHeader, FACE_PHOTO_READ_SCOPE);
    const userId = pathUserId(req.path, "photo/");
    return handleRead(userId, {
      actorUserId: principal.actorUserId,
      ...(principal.kind === "tool" ? { actorServiceId: principal.subject } : {}),
    });
  }

  if (req.method === "DELETE" && req.path.startsWith("photo/")) {
    const principal = await requireServiceScope(req.authHeader, FACE_PHOTO_MANAGE_SCOPE);
    const userId = pathUserId(req.path, "photo/");
    const input = validate(serviceDeleteSchema, parseJson(req.body));
    const actor = managementActor(principal, input.enrolledBy);
    const removed = await deleteFacePhoto(userId, input.reason);
    await recordFaceAudit({
      action: "identity.face_photo.delete",
      ...actor,
      targetUserId: userId,
      reason: input.reason,
    });
    return { status: "200 OK", data: removed };
  }

  if (req.method === "POST" && req.path.endsWith("/promote") && req.path.startsWith("template/")) {
    const principal = await requireServiceScope(req.authHeader, FACE_PHOTO_MANAGE_SCOPE);
    const userId = pathUserId(req.path, "template/", "/promote");
    const input = validate(promoteSchema, parseJson(req.body));
    const actor = managementActor(principal, input.enrolledBy);
    const result = await promoteFaceTemplate({
      userId,
      facilityId: input.facilityId,
      enrolledBy: input.enrolledBy,
      mode: input.mode,
    });
    await recordFaceAudit({
      action: "identity.face_template.promote",
      ...actor,
      targetUserId: userId,
      facilityId: input.facilityId,
      reason: input.mode,
    });
    return { status: "200 OK", data: result };
  }

  if (req.method === "POST" && req.path.endsWith("/reject") && req.path.startsWith("template/")) {
    const principal = await requireServiceScope(req.authHeader, FACE_PHOTO_MANAGE_SCOPE);
    const userId = pathUserId(req.path, "template/", "/reject");
    const input = validate(rejectSchema, parseJson(req.body));
    const actor = managementActor(principal, input.enrolledBy);
    const result = await rejectFaceTemplate({
      userId,
      facilityId: input.facilityId,
      enrolledBy: input.enrolledBy,
      reason: input.reason,
    });
    await recordFaceAudit({
      action: "identity.face_template.reject",
      ...actor,
      targetUserId: userId,
      facilityId: input.facilityId,
      reason: input.reason,
    });
    return { status: "200 OK", data: result };
  }

  throw AppError.notFound("Unknown face photo route");
}
