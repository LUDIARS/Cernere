/**
 * OIDC クライアント (RP) ストア
 *
 * Cernere を IdP とする OpenID Connect Relying Party (Cloudflare Access 等) の
 * 登録・参照・失効を扱う。 client_secret は bcrypt ハッシュで保存し、 平文は
 * 登録/ローテーション時の戻り値で 1 度だけ返す (= 再取得不可)。
 *
 * redirect_uri は完全一致リストでのみ許可する。 部分一致やワイルドカードは
 * open redirect / token 横取りの温床になるため採用しない。
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { SUPPORTED_SCOPES } from "./scopes.js";

export interface OidcClientPublic {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface OidcClientRecord extends OidcClientPublic {
  clientSecretHash: string;
}

function toPublic(row: typeof schema.oidcClients.$inferSelect): OidcClientPublic {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: (row.redirectUris as string[]) ?? [],
    scopes: (row.scopes as string[]) ?? [],
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input)) throw AppError.badRequest("redirect_uris must be an array");
  const uris = input.map((u) => String(u).trim()).filter(Boolean);
  if (uris.length === 0) throw AppError.badRequest("at least one redirect_uri is required");
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw AppError.badRequest(`invalid redirect_uri: ${uri}`);
    }
    // フラグメントは OIDC で redirect_uri に含めてはならない。
    if (parsed.hash) throw AppError.badRequest(`redirect_uri must not contain a fragment: ${uri}`);
    // http は localhost 開発時のみ許容、 それ以外は https を要求。
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw AppError.badRequest(`redirect_uri must use https (got ${uri})`);
    }
  }
  return uris;
}

function normalizeScopes(input: unknown): string[] {
  if (input === undefined || input === null) return [...SUPPORTED_SCOPES];
  if (!Array.isArray(input)) throw AppError.badRequest("scopes must be an array");
  const scopes = input.map((s) => String(s).trim()).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  for (const s of scopes) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(s)) throw AppError.badRequest(`unsupported scope: ${s}`);
  }
  return scopes;
}

export interface RegisterResult {
  client: OidcClientPublic;
  /** 平文 client_secret。 ここでしか取得できない。 */
  clientSecret: string;
}

/** 新規 RP を登録する。 戻り値の clientSecret は再取得不可。 */
export async function registerClient(
  p: Record<string, unknown> | undefined,
  createdBy: string | null,
): Promise<RegisterResult> {
  const name = typeof p?.name === "string" ? p.name.trim() : "";
  if (!name) throw AppError.badRequest("name is required");

  const redirectUris = normalizeRedirectUris(p?.redirectUris ?? p?.redirect_uris);
  const scopes = normalizeScopes(p?.scopes);

  // client_id は推測困難な公開識別子。 client_secret は高エントロピー乱数。
  const clientId = `oidc_${randomBytes(12).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("base64url");
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  const rows = await db.insert(schema.oidcClients).values({
    clientId,
    clientSecretHash,
    name,
    redirectUris,
    scopes,
    createdBy: createdBy ?? undefined,
  }).returning();

  return { client: toPublic(rows[0]), clientSecret };
}

export async function listClients(): Promise<OidcClientPublic[]> {
  const rows = await db.select().from(schema.oidcClients);
  return rows.map(toPublic);
}

/** clientId から RP を取得する (内部用、 secret ハッシュ込み)。 */
export async function getClientByClientId(clientId: string): Promise<OidcClientRecord | null> {
  const rows = await db.select().from(schema.oidcClients)
    .where(eq(schema.oidcClients.clientId, clientId)).limit(1);
  if (rows.length === 0) return null;
  return { ...toPublic(rows[0]), clientSecretHash: rows[0].clientSecretHash };
}

/** client_secret を検証する (bcrypt)。 */
export async function verifyClientSecret(record: OidcClientRecord, secret: string): Promise<boolean> {
  return bcrypt.compare(secret, record.clientSecretHash);
}

/** redirect_uri が登録済みリストに完全一致するか。 */
export function isRedirectUriAllowed(record: OidcClientRecord, redirectUri: string): boolean {
  return record.redirectUris.includes(redirectUri);
}

export async function rotateSecret(clientId: string): Promise<{ client: OidcClientPublic; clientSecret: string }> {
  const existing = await getClientByClientId(clientId);
  if (!existing) throw AppError.notFound("OIDC client not found");
  const clientSecret = randomBytes(32).toString("base64url");
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);
  const rows = await db.update(schema.oidcClients)
    .set({ clientSecretHash, updatedAt: new Date() })
    .where(eq(schema.oidcClients.clientId, clientId)).returning();
  return { client: toPublic(rows[0]), clientSecret };
}

export async function updateRedirectUris(clientId: string, input: unknown): Promise<OidcClientPublic> {
  const redirectUris = normalizeRedirectUris(input);
  const rows = await db.update(schema.oidcClients)
    .set({ redirectUris, updatedAt: new Date() })
    .where(eq(schema.oidcClients.clientId, clientId)).returning();
  if (rows.length === 0) throw AppError.notFound("OIDC client not found");
  return toPublic(rows[0]);
}

export async function setActive(clientId: string, isActive: boolean): Promise<OidcClientPublic> {
  const rows = await db.update(schema.oidcClients)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(schema.oidcClients.clientId, clientId)).returning();
  if (rows.length === 0) throw AppError.notFound("OIDC client not found");
  return toPublic(rows[0]);
}

export async function touchLastUsed(clientId: string): Promise<void> {
  await db.update(schema.oidcClients)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.oidcClients.clientId, clientId));
}
