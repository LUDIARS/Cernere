/** Purpose-separated, single-use codes. No access or refresh token is stored here. */
import { randomBytes } from "node:crypto";
import { isPkceS256Challenge, verifyPkceS256 } from "../lib/crypto/pkce.js";
import type { UserSessionState } from "./user-session-state.js";

export const COMPOSITE_AUTH_CODE_TTL_SECONDS = 60;
export type AuthCodeBinding =
  | { audience: "service"; projectKey: string; origin: string; codeChallenge: string }
  | { audience: "cernere"; origin: string; codeChallenge: string }
  | { audience: "kiosk"; projectKey: string };

export interface StoredAuthCode {
  version: 1;
  binding: AuthCodeBinding;
  subject: UserSessionState & { authEpoch: number };
}

export interface AuthCodeRedis {
  set(key: string, value: string, expiry: "EX", seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

function validBinding(value: unknown): value is AuthCodeBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  if (b.audience === "kiosk") return typeof b.projectKey === "string" && b.projectKey.length > 0;
  if (b.audience !== "service" && b.audience !== "cernere") return false;
  if (typeof b.origin !== "string" || !isPkceS256Challenge(b.codeChallenge)) return false;
  try { if (new URL(b.origin).origin !== b.origin) return false; } catch { return false; }
  return b.audience === "cernere" || (typeof b.projectKey === "string" && b.projectKey.length > 0);
}

function parse(raw: string): StoredAuthCode | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredAuthCode> | null;
    if (!value || value.version !== 1 || !validBinding(value.binding) || !value.subject
      || typeof value.subject.sub !== "string" || !value.subject.sub
      || typeof value.subject.role !== "string" || !Number.isInteger(value.subject.authEpoch)
      || Number(value.subject.authEpoch) < 0) return null;
    return value as StoredAuthCode;
  } catch { return null; }
}

export type AuthCodeExchangeExpectation =
  | { audience: "service"; projectKey: string; codeVerifier: string }
  | { audience: "cernere"; origin: string; codeVerifier: string }
  | { audience: "kiosk"; projectKey: string };

export class AuthCodeStore {
  constructor(private readonly redis: AuthCodeRedis, private readonly random: () => string = () => randomBytes(32).toString("base64url")) {}

  async issue(binding: AuthCodeBinding, subject: StoredAuthCode["subject"]): Promise<string> {
    const record: StoredAuthCode = { version: 1, binding, subject };
    if (!parse(JSON.stringify(record))) throw new Error("Invalid authorization code binding");
    const code = this.random();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Invalid authorization code entropy source");
    await this.redis.set(`authcode:${code}`, JSON.stringify(record), "EX", COMPOSITE_AUTH_CODE_TTL_SECONDS);
    return code;
  }

  async consume(code: string, expected: AuthCodeExchangeExpectation): Promise<StoredAuthCode | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    // All endpoints consume the same key with GETDEL. An invalid attempt also burns the code.
    const raw = await this.redis.getdel(`authcode:${code}`);
    const record = raw ? parse(raw) : null;
    if (!record || record.binding.audience !== expected.audience) return null;
    const binding = record.binding;
    if (binding.audience === "kiosk" && expected.audience === "kiosk") {
      return binding.projectKey === expected.projectKey ? record : null;
    }
    if (binding.audience === "service" && expected.audience === "service") {
      return binding.projectKey === expected.projectKey && verifyPkceS256(expected.codeVerifier, binding.codeChallenge) ? record : null;
    }
    if (binding.audience === "cernere" && expected.audience === "cernere") {
      return binding.origin === expected.origin && verifyPkceS256(expected.codeVerifier, binding.codeChallenge) ? record : null;
    }
    return null;
  }
}
