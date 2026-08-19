/**
 * scope 付き service 認可。
 *
 * export-auth.ts は「admin user か project token か」だけを見る粗い判定で、
 * scope を持たない。顔写真の単体取得・審査管理のように **限定した権限だけを渡したい**
 * 経路のために、scope を明示的に要求する判定をここに分ける。
 *
 * 受理するのは次のいずれか:
 *   1. tool_clients で active かつ要求 scope を持つ tool token
 *   2. users.role === 'admin' の user access token (運用者の手動確認)
 *
 * project token は tool_client の owner / scope を持たないため **拒否する**。
 * 写真は個人データそのもので、既存の service token に暗黙で権限が付くのを避ける。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { AppError } from "../error.js";

export interface ServiceScopePrincipal {
  kind: "tool" | "admin";
  subject: string;
  actorUserId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requireServiceScope(authHeader: string, scope: string): Promise<ServiceScopePrincipal> {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");

  const claims = verifyToken(token) as unknown as {
    sub?: string;
    owner?: string;
    scopes?: unknown;
    tokenType?: unknown;
  };
  if (typeof claims.sub !== "string") throw AppError.unauthorized("Invalid bearer token");
  if (claims.tokenType === "project") {
    throw AppError.forbidden(`Scope ${scope} is required`);
  }
  if (!UUID_PATTERN.test(claims.sub)) throw AppError.unauthorized("Invalid bearer token subject");

  if (typeof claims.owner === "string" && claims.tokenType !== "project") {
    const rows = await db.select({
      ownerUserId: schema.toolClients.ownerUserId,
      scopes: schema.toolClients.scopes,
      isActive: schema.toolClients.isActive,
    }).from(schema.toolClients).where(eq(schema.toolClients.id, claims.sub)).limit(1);
    const client = rows[0];
    const currentScopes = Array.isArray(client?.scopes)
      ? client.scopes.filter((item): item is string => typeof item === "string")
      : [];
    if (client?.isActive && client.ownerUserId === claims.owner && currentScopes.includes(scope)) {
      return { kind: "tool", subject: claims.sub, actorUserId: claims.owner };
    }
    throw AppError.forbidden(`Scope ${scope} is required`);
  }

  const rows = await db.select({ role: schema.users.role })
    .from(schema.users).where(eq(schema.users.id, claims.sub)).limit(1);
  if (rows[0]?.role === "admin") {
    return { kind: "admin", subject: claims.sub, actorUserId: claims.sub };
  }

  throw AppError.forbidden(`Scope ${scope} is required`);
}
