/**
 * onsite challenge の nonce と充足記録の Redis 状態 (SPEC-MFA-ONSITE)。
 *
 * - nonce は 32 byte 乱数 base64url。 平文は利用者端末に返すだけで保存しない (sha256 で引く)。
 * - nonce は MFA ticket (mfaToken) に束縛し、 期限は ticket の残り時間と同じ。
 * - 受理時に nonce を "used" へ原子的に遷移させ、 同時に ticket へ充足を記録する。
 *   ticket 自体は消費しない (消費は MFA verify の一回消費が担う)。
 */

import { createHash, randomBytes } from "node:crypto";
import { redis as defaultRedis } from "../redis.js";
import { onsiteSatisfactionKey } from "./mfa-records.js";

const USED = "used";

interface RedisLike {
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export type OnsiteNonceState = { state: "unknown" } | { state: "used" } | { state: "active"; ticketDigest: string };
export type OnsiteCommitResult = "accepted" | "used" | "unknown";

function nonceKey(nonce: string): string {
  return `mfa-onsite-nonce:${createHash("sha256").update(nonce).digest("hex")}`;
}
function currentNonceKey(ticketDigest: string): string { return `mfa-onsite-current:${ticketDigest}`; }

// Rotating: a new start replaces the previous nonce of the same ticket, which becomes unknown.
export const ISSUE_ONSITE_NONCE = `
local previous = redis.call('GET', KEYS[2])
if previous then redis.call('DEL', previous) end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], KEYS[1], 'EX', ARGV[2])
return 1
`;

// The nonce is single-use: only the first accepted attestation moves it to "used".
export const COMMIT_ONSITE_NONCE = `
local bound = redis.call('GET', KEYS[1])
if bound == '${USED}' then return -1 end
if bound ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('SET', KEYS[1], '${USED}', 'KEEPTTL')
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
return 1
`;

export class OnsiteChallengeStore {
  constructor(private readonly client: RedisLike = defaultRedis,
    private readonly random: (size: number) => Buffer = randomBytes) {}

  async issueNonce(ticketDigest: string, ttlSeconds: number): Promise<string> {
    const nonce = this.random(32).toString("base64url");
    await this.client.eval(ISSUE_ONSITE_NONCE, 2, nonceKey(nonce), currentNonceKey(ticketDigest), ticketDigest, ttlSeconds);
    return nonce;
  }

  async lookupNonce(nonce: string): Promise<OnsiteNonceState> {
    const bound = await this.client.get(nonceKey(nonce));
    if (!bound) return { state: "unknown" };
    if (bound === USED) return { state: "used" };
    return { state: "active", ticketDigest: bound };
  }

  async commit(nonce: string, ticketDigest: string, satisfactionJson: string, ttlSeconds: number): Promise<OnsiteCommitResult> {
    const result = Number(await this.client.eval(COMMIT_ONSITE_NONCE, 3, nonceKey(nonce), `mfa-ticket:${ticketDigest}`,
      onsiteSatisfactionKey(ticketDigest), ticketDigest, satisfactionJson, ttlSeconds));
    if (result === 1) return "accepted";
    return result === -1 ? "used" : "unknown";
  }

  async readSatisfaction(ticketDigest: string): Promise<string | null> {
    return this.client.get(onsiteSatisfactionKey(ticketDigest));
  }
}

export const onsiteChallengeStore = new OnsiteChallengeStore();
