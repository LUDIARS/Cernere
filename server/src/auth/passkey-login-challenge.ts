/** One-use WebAuthn challenges bound to the intended token recipient.
 * @implements SPEC-COMPOSITE-PROJECT-PKCE
 */
import type { AuthCodeBinding } from "./auth-code-store.js";

export interface PasskeyLoginIntent {
  binding: AuthCodeBinding | null;
  expectedOrigins: string[];
  /** Service frames must be embedded by the same destination, never another project. */
  embeddingOrigins: string[] | null;
  /** Exact protocol fields, including kiosk PKCE and the handoff destination. */
  request: { target: string; targetMode: string; state: string; codeChallenge: string } | null;
}

interface ChallengeRedis {
  set(key: string, value: string, expiry: "EX", seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export class PasskeyLoginChallengeStore {
  constructor(private readonly redis: ChallengeRedis, private readonly ttlSeconds: number) {}

  async issue(owner: string, challenge: string, intent: PasskeyLoginIntent): Promise<void> {
    await this.redis.set(`passkey:challenge:login:${owner}`, JSON.stringify({ version: 1, challenge, intent }), "EX", this.ttlSeconds);
  }

  async consume(owner: string, expected: PasskeyLoginIntent): Promise<string> {
    // Mismatched completions also consume the challenge; no parallel second use.
    const raw = await this.redis.getdel(`passkey:challenge:login:${owner}`);
    if (!raw) throw new Error("Challenge expired or missing — please retry");
    let record: { version?: unknown; challenge?: unknown; intent?: unknown };
    try { record = JSON.parse(raw); } catch { throw new Error("Invalid passkey challenge"); }
    if (!record || record.version !== 1 || typeof record.challenge !== "string" || !record.challenge
      || JSON.stringify(record.intent) !== JSON.stringify(expected)) {
      throw new Error("Passkey challenge purpose or destination changed");
    }
    return record.challenge;
  }
}
