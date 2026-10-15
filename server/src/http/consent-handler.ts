/**
 * /consent 画面の REST 境界 (spec/plan/2026-10-15-service-consent-design.md §4.2 / §4.3)。
 *
 *   GET  /api/consent/ticket?ticket=   表示データ (必須/推奨・目的・誰が読めるか)
 *   POST /api/consent/decide            { ticket, decision: "grant" | "deny", recommended: string[], fields?: {列: 値} }
 *                                       入力項目の誤りは 422 { code: "signup_fields_invalid", fieldErrors } (何も保存しない)
 *
 * popup の composite ログインは Cernere のセッションを持たないことがあるため WS ではなく REST にする。
 * 判断の権限 (Origin / 本人セッション) と継続先の決定は consent/ticket-flow.ts に閉じる。
 */

import { z } from "zod";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { AppError } from "../error.js";
import { decideConsentTicket, describeConsentTicket, type ConsentViewer } from "../consent/ticket-flow.js";
import { SignupFieldsInvalidError, signupFieldsInvalidBody } from "../signup-fields/errors.js";
import { isCernereFrontendOrigin } from "./cernere-origin.js";

export interface ConsentRouteResult { status: string; data: unknown }

const ticketSchema = z.string().min(32).max(128);
const decideSchema = z.object({
  ticket: ticketSchema,
  decision: z.enum(["grant", "deny"]),
  recommended: z.array(z.string().max(160)).max(100).default([]),
  fields: z.record(z.string().max(128), z.unknown()).optional(),
}).strict();

/** Bearer は任意。無効な token は「セッション無し」として扱う (判断の可否は ticket-flow が決める)。 */
async function viewerOf(authHeader: string, origin: string | undefined): Promise<ConsentViewer> {
  const token = extractBearerToken(authHeader);
  let userId: string | undefined;
  if (token) {
    try { userId = (await verifyToken(token)).sub; } catch { userId = undefined; }
  }
  return { userId, fromCernereFrontend: isCernereFrontendOrigin(origin) };
}

function parseBody(body: string): unknown {
  try { return JSON.parse(body || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); }
}

export async function handleConsentRoute(
  action: "ticket" | "decide",
  input: { body: string; query: string; authHeader: string; origin?: string },
): Promise<ConsentRouteResult> {
  const viewer = await viewerOf(input.authHeader, input.origin);
  if (action === "ticket") {
    const ticket = ticketSchema.safeParse(new URLSearchParams(input.query).get("ticket") ?? "");
    if (!ticket.success) throw AppError.badRequest("ticket is required");
    return { status: "200 OK", data: await describeConsentTicket(ticket.data, viewer) };
  }
  const parsed = decideSchema.safeParse(parseBody(input.body));
  if (!parsed.success) throw AppError.badRequest("ticket and decision are required");
  try {
    const outcome = await decideConsentTicket(parsed.data.ticket, {
      decision: parsed.data.decision, recommended: parsed.data.recommended, fields: parsed.data.fields,
    }, viewer);
    return { status: "200 OK", data: outcome };
  } catch (error) {
    if (error instanceof SignupFieldsInvalidError) return { status: "422 Unprocessable Entity", data: signupFieldsInvalidBody(error) };
    throw error;
  }
}
