/** Server-owned revocation snapshot behind a service-bound token's opaque grant reference. */
import { randomUUID } from "node:crypto";
import { redis } from "../redis.js";
import type { UserSessionState } from "./user-session-state.js";

export const COMPOSITE_GRANT_TTL_SECONDS = 900;
export interface CompositeGrant {
  version: 1;
  projectKey: string;
  audience: string;
  subjectId: string;
  role: string;
  source: UserSessionState & { authEpoch: number };
  consentRevision: string | null;
  issuedAt: number;
}

export async function createCompositeGrant(input: Omit<CompositeGrant, "version" | "issuedAt">): Promise<string> {
  const id = randomUUID();
  await redis.set(`composite-grant:${id}`, JSON.stringify({ ...input, version: 1, issuedAt: Date.now() }), "EX", COMPOSITE_GRANT_TTL_SECONDS);
  return id;
}

export async function readCompositeGrant(id: string): Promise<CompositeGrant | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const raw = await redis.get(`composite-grant:${id}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CompositeGrant> | null;
    if (!value || value.version !== 1 || typeof value.projectKey !== "string" || typeof value.audience !== "string"
      || typeof value.subjectId !== "string" || typeof value.role !== "string" || !value.source
      || typeof value.source.sub !== "string" || !Number.isInteger(value.source.authEpoch)
      || (value.consentRevision !== null && typeof value.consentRevision !== "string")
      || typeof value.issuedAt !== "number" || !Number.isFinite(value.issuedAt)
      || value.issuedAt > Date.now() || value.issuedAt + COMPOSITE_GRANT_TTL_SECONDS * 1000 <= Date.now()) return null;
    return value as CompositeGrant;
  } catch { return null; }
}
