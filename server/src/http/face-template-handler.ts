import { eq } from "drizzle-orm";
import { z } from "zod";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { requireExportAuth } from "./export-auth.js";
import { createFaceConsent, exportFaceTemplates, faceConsentPolicy, listFaceTemplateStatus, putFaceTemplate, revokeFaceTemplates } from "../identity/face-template-store.js";

export interface FaceRouteResult { status: string; data: unknown }
const uuidSchema = z.string().uuid();
const base64Schema = z.string()
  .min(1)
  .max(1_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const putSchema = z.object({
  userId: uuidSchema,
  template: base64Schema,
  modelId: z.string().trim().min(1).max(128),
  quality: z.number().finite().min(0).max(100),
  facilityId: uuidSchema,
  enrolledBy: uuidSchema,
  consentId: uuidSchema,
}).strict();
const consentSchema = z.object({
  policyVersion: z.string().trim().min(1).max(128),
  facilityId: uuidSchema,
}).strict();
const querySchema = z.object({ facilityId: uuidSchema.optional() }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(256) }).strict();

function parse(body: string): unknown { try { return JSON.parse(body || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); } }
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.badRequest("Invalid face identity request");
  return result.data;
}

function parseQuery(query: string): z.infer<typeof querySchema> {
  return validate(querySchema, Object.fromEntries(new URLSearchParams(query)));
}

function currentUser(authHeader: string): string {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");
  const claims = verifyToken(token);
  if (!claims.sub) throw AppError.unauthorized("Invalid bearer token");
  return claims.sub;
}

export async function handleFaceTemplateRoute(method: string, path: string, body: string, authHeader: string, query: string): Promise<FaceRouteResult> {
  const { facilityId } = parseQuery(query);
  if (method === "GET" && path === "policy") return { status: "200 OK", data: faceConsentPolicy };
  if (method === "POST" && path === "consent") {
    const userId = currentUser(authHeader);
    const input = validate(consentSchema, parse(body));
    return { status: "201 Created", data: await createFaceConsent(userId, input.policyVersion, input.facilityId) };
  }
  if (method === "GET" && path === "status") return { status: "200 OK", data: await listFaceTemplateStatus(currentUser(authHeader)) };
  if (method === "PUT" && path === "template") {
    await requireExportAuth(authHeader);
    const input = validate(putSchema, parse(body));
    return { status: "200 OK", data: await putFaceTemplate(input) };
  }
  if (method === "DELETE" && path === "template") return { status: "200 OK", data: await revokeFaceTemplates(currentUser(authHeader), facilityId, "user_revoked", true) };
  if (method === "DELETE" && path.startsWith("template/")) {
    await requireExportAuth(authHeader);
    const userId = validate(uuidSchema, path.slice("template/".length));
    if (!facilityId) throw AppError.badRequest("facilityId is required");
    const { reason } = validate(reasonSchema, parse(body));
    return { status: "200 OK", data: await revokeFaceTemplates(userId, facilityId, reason, false) };
  }
  if (method === "GET" && path === "export") {
    await requireExportAuth(authHeader);
    if (!facilityId) throw AppError.badRequest("facilityId is required");
    return { status: "200 OK", data: await exportFaceTemplates(facilityId) };
  }
  if (method === "GET" && path === "roster") {
    await requireExportAuth(authHeader);
    if (!facilityId) throw AppError.badRequest("facilityId is required");
    const rows = await db.select({ userId: schema.users.id, name: schema.users.displayName, role: schema.organizationMembers.role })
      .from(schema.organizationMembers).innerJoin(schema.users, eq(schema.organizationMembers.userId, schema.users.id))
      .where(eq(schema.organizationMembers.organizationId, facilityId));
    return { status: "200 OK", data: { users: rows.map((r) => ({ userId: r.userId, hint: weakHint(r.name, r.userId), roles: [r.role] })) } };
  }
  throw AppError.notFound("Unknown face identity route");
}

function weakHint(name: string, userId: string): string {
  const initial = name.split(/\s+/).filter(Boolean).map((part) => `${part[0]}.`).join("");
  return `${initial || "user"} / ${userId.slice(-2)}`;
}
