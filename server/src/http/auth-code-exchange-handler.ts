/** Kiosk-only code exchange. Service/self codes and legacy records never enter this path. */
import { ACCESS_TOKEN_SECONDS, generateAccessToken } from "../auth/jwt.js";
import { assertUserSessionCurrent } from "../auth/user-session-state.js";
import { requireServiceAccess } from "../federation/subject.js";
import { authCodeStore } from "../auth/auth-code.js";
import { AppError } from "../error.js";
import { EXPORT_SCOPES, requireExportAuth } from "./export-auth.js";

export interface AuthCodeExchangeResult {
  status: string;
  data: unknown;
  headers: Readonly<Record<string, string>>;
}

export async function handleAuthCodeExchange(body: string, authHeader: string): Promise<AuthCodeExchangeResult> {
  const principal = await requireExportAuth(authHeader, EXPORT_SCOPES.kioskCodeExchange);
  if (principal.kind !== "project") throw AppError.unauthorized("Invalid or expired auth code");
  let input: unknown;
  try { input = JSON.parse(body); } catch { throw AppError.badRequest("Invalid JSON"); }
  const code = input && typeof input === "object" ? (input as { code?: unknown }).code : undefined;
  if (typeof code !== "string") throw AppError.badRequest("code is required");
  const record = await authCodeStore.consume(code, { audience: "kiosk", projectKey: principal.projectKey });
  if (!record) throw AppError.unauthorized("Invalid or expired auth code");
  await assertUserSessionCurrent(record.subject);
  await requireServiceAccess(record.subject.sub);
  const accessToken = await generateAccessToken(record.subject.sub, record.subject.role, record.subject.authentication,
    { authEpoch: record.subject.authEpoch, deviceId: record.subject.deviceId });
  return { status: "200 OK", data: { userId: record.subject.sub, accessToken, expiresIn: ACCESS_TOKEN_SECONDS },
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" } };
}
