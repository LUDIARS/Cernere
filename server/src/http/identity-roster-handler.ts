/**
 * 施設名簿 API (GET /api/identity/roster?facilityId=)。
 *
 * kiosk (Ostiarius) が誰を照合対象にしてよいかを知るための最小情報だけを返す。
 * 氏名フルは返さず、弱識別 hint と所属 role に留める (kiosk 画面に他人の
 * 個人情報を出さないため)。
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { requireExportAuth } from "./export-auth.js";

export interface IdentityRosterRouteResult { status: string; data: unknown }

const querySchema = z.object({ facilityId: z.string().uuid() }).strict();

export async function handleIdentityRosterRoute(
  method: string,
  authHeader: string,
  query: string,
): Promise<IdentityRosterRouteResult> {
  if (method !== "GET") throw AppError.notFound("Unknown identity roster route");
  await requireExportAuth(authHeader);
  const parsed = querySchema.safeParse(Object.fromEntries(new URLSearchParams(query)));
  if (!parsed.success) throw AppError.badRequest("facilityId is required");

  const rows = await db.select({
    userId: schema.users.id,
    name: schema.users.displayName,
    role: schema.organizationMembers.role,
  })
    .from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.organizationMembers.userId, schema.users.id))
    .where(eq(schema.organizationMembers.organizationId, parsed.data.facilityId));

  return {
    status: "200 OK",
    data: {
      users: rows.map((row) => ({
        userId: row.userId,
        hint: weakHint(row.name, row.userId),
        roles: [row.role],
      })),
    },
  };
}

function weakHint(name: string, userId: string): string {
  const initial = name.split(/\s+/).filter(Boolean).map((part) => `${part[0]}.`).join("");
  return `${initial || "user"} / ${userId.slice(-2)}`;
}
