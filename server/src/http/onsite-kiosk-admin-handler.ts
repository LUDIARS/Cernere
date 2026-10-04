/**
 * kiosk 公開鍵レジストリの管理者 API (契約 B)。
 *
 *   POST /api/admin/onsite-kiosks               { lanId, placeId, publicKeyPem, lanUrl, label? }  upsert
 *   GET  /api/admin/onsite-kiosks
 *   POST /api/admin/onsite-kiosks/:lanId/revoke
 *
 * 認可は admin ロールの user access token だけ。 project / tool / service token は受けない
 * (service token の保持者が鍵を足せると偽 kiosk を作れるため、 自己登録経路を持たない)。
 * @implements SPEC-MFA-ONSITE
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { lanIdSchema, parseOnsiteKioskInput } from "../auth/onsite-kiosk-input.js";
import { listOnsiteKiosks, registerOnsiteKiosk, revokeOnsiteKiosk, type OnsiteKioskRow } from "../auth/onsite-kiosk-registry.js";
import { currentUser } from "./face-identity-auth.js";

export interface OnsiteKioskView {
  lanId: string; placeId: string; publicKeyPem: string; lanUrl: string; label: string | null;
  status: string; createdAt: string; updatedAt: string; revokedAt: string | null;
}

function view(row: OnsiteKioskRow): OnsiteKioskView {
  return { lanId: row.lanId, placeId: row.placeId, publicKeyPem: row.publicKeyPem, lanUrl: row.lanUrl, label: row.label,
    status: row.status, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null };
}

async function requireAdminUser(authHeader: string): Promise<string> {
  const userId = await currentUser(authHeader);
  const rows = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (rows[0]?.role !== "admin") throw AppError.forbidden("Admin role is required");
  return userId;
}

export async function handleOnsiteKioskAdmin(action: "list" | "register" | "revoke", authHeader: string,
  body: unknown, lanId = ""): Promise<unknown> {
  const actor = await requireAdminUser(authHeader);
  if (action === "list") return { kiosks: (await listOnsiteKiosks()).map(view) };
  if (action === "register") {
    const kiosk = await registerOnsiteKiosk(parseOnsiteKioskInput(body));
    logAuthEvent({ event: "admin.onsite_kiosk.registered", userId: actor, lanId: kiosk.lanId, placeId: kiosk.placeId });
    return { kiosk: view(kiosk) };
  }
  if (!lanIdSchema.safeParse(lanId).success) throw AppError.badRequest("Invalid lanId");
  const kiosk = await revokeOnsiteKiosk(lanId);
  logAuthEvent({ event: "admin.onsite_kiosk.revoked", userId: actor, lanId: kiosk.lanId, placeId: kiosk.placeId });
  return { kiosk: view(kiosk) };
}
