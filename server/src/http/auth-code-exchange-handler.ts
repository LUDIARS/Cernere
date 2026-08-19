/**
 * kiosk 向け限定 authCode 交換 (`POST /api/auth/code/exchange`)。
 *
 * 既存の `POST /api/auth/exchange` は無認可で `{ accessToken, refreshToken, user }`
 * を丸ごと返す。 共有端末 (Ostiarius kiosk) にそれを渡すと、 生徒が立ち去った後も
 * 30 日有効な refreshToken が端末側に残る。 顔テンプレート登録の立会いフローは
 * 「生徒が今ここに居ること」 だけを確かめられればよいので、 交換口を分ける。
 *
 * 契約 (Ostiarius/spec/interface/cernere-face-template.md §認証):
 *   - 呼び出しは service token (export と同じ CERNERE_SERVICE_TOKEN)。 無認可では開けない
 *   - 返すのは `{ userId, accessToken, expiresIn }` のみ。 refreshToken は返さない
 *   - authCode は one-time。 交換と同時に Redis から削除する
 *   - 併せて issueAuthCode が先に作った refresh_sessions 行も削除する。
 *     誰にも渡さない refreshToken の行を 30 日残さないため
 *
 * accessToken (15 分) は Ostiarius が同意記録 `POST /api/identity/face-consent` を
 * 生徒本人として打つためだけに使い、 保存しない。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { ACCESS_TOKEN_SECONDS } from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { AppError } from "../error.js";
import { devLog } from "../logging/dev-logger.js";
import { redis } from "../redis.js";
import { requireExportAuth } from "./export-auth.js";

export interface AuthCodeExchangeResult {
  status: string;
  data: unknown;
  headers: Readonly<Record<string, string>>;
}

interface StoredAuthCode {
  accessToken?: unknown;
  refreshToken?: unknown;
  user?: { id?: unknown } | null;
}

export async function handleAuthCodeExchange(body: string, authHeader: string): Promise<AuthCodeExchangeResult> {
  const principal = await requireExportAuth(authHeader);
  const code = parseCode(body);
  // The public exchange route consumes the same keyspace. GETDEL keeps the
  // one-time guarantee even when both endpoints receive the code concurrently.
  const raw = await redis.getdel(`authcode:${code}`);
  devLog("auth.codeExchange.lookup", { principal: principal.kind, found: raw !== null });
  if (!raw) throw AppError.unauthorized("Invalid or expired auth code");

  const stored = parseStored(raw);
  const userId = typeof stored.user?.id === "string" ? stored.user.id : null;
  const accessToken = typeof stored.accessToken === "string" ? stored.accessToken : null;
  if (!userId || !accessToken) throw AppError.unauthorized("Invalid or expired auth code");
  await dropRefreshSession(stored.refreshToken);

  devLog("auth.codeExchange.done");
  return {
    status: "200 OK",
    data: { userId, accessToken, expiresIn: ACCESS_TOKEN_SECONDS },
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  };
}

function parseCode(body: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(body || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); }
  const code = (parsed as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code) throw AppError.badRequest("code is required");
  return code;
}

function parseStored(raw: string): StoredAuthCode {
  try { return JSON.parse(raw) as StoredAuthCode; } catch { throw AppError.unauthorized("Invalid or expired auth code"); }
}

/** 交換先へ渡さない refreshToken のセッション行を消す (残すと未使用の長期資格情報になる)。 */
async function dropRefreshSession(refreshToken: unknown): Promise<void> {
  if (typeof refreshToken !== "string" || !refreshToken) return;
  await db.delete(schema.refreshSessions)
    .where(eq(schema.refreshSessions.refreshToken, hashRefreshToken(refreshToken)));
}
