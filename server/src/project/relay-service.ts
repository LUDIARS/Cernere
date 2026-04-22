/**
 * Service Adapter Relay — peer WS 接続の仲介 (Phase 0b).
 *
 * Cernere は認証局・仲介役に徹し、確立後のデータ経路 (peer ↔ peer) には
 * 一切関与しない. このファイルはその仲介ロジックを提供する:
 *
 *   1. SA が立てた WS サーバの listen URL を在庫管理 (registerEndpoint)
 *   2. A から request_peer 要求が来たら
 *      - relay_pairs で (A, B) ペアの許可を確認
 *      - B の endpoint URL を返す
 *      - 60 秒 TTL の challenge を発行して A に返す
 *   3. B (callee) が接続を受けて Cernere に問い合わせてきたら verifyChallenge で判定
 *
 * 揮発状態 (endpoint registry / pending challenges) は in-memory.
 * Cernere プロセス再起動で全クリア、各 SA が自動再登録する運用.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

const CHALLENGE_TTL_MS = 60_000;

export class RelayError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RelayError";
  }
}

// ─── Endpoint Registry ────────────────────────────────────────

/** projectKey → SA WS URL (dynamic port). */
const endpoints = new Map<string, string>();

export function registerEndpoint(projectKey: string, saWsUrl: string): void {
  if (!projectKey) throw new RelayError("bad_project", "projectKey required");
  if (!/^wss?:\/\/.+/.test(saWsUrl)) {
    throw new RelayError("bad_url", "saWsUrl must be ws://... or wss://...");
  }
  endpoints.set(projectKey, saWsUrl);
}

export function unregisterEndpoint(projectKey: string): void {
  endpoints.delete(projectKey);
}

export function getRegisteredEndpoint(projectKey: string): string | undefined {
  return endpoints.get(projectKey);
}

// ─── Challenge Store ──────────────────────────────────────────

interface PendingChallenge {
  challenge:  string;
  issuerKey:  string; // 呼び出し元 (A)
  targetKey:  string; // 呼び出し先 (B)
  expiresAt:  number; // Unix ms
}

/** challenge → record. */
const challenges = new Map<string, PendingChallenge>();

function sweepExpired(now: number): void {
  for (const [k, v] of challenges) {
    if (v.expiresAt <= now) challenges.delete(k);
  }
}

function newChallenge(): string {
  // UUID では不足 (短すぎ), 32 バイト分の乱数を base64url で.
  return randomBytes(32).toString("base64url");
}

// ─── Pair Authorization ───────────────────────────────────────

/**
 * `from → to` 方向の relay が許可されているか DB で確認.
 * bidirectional=true の逆方向エントリも許容.
 */
async function isPairAllowed(fromKey: string, toKey: string): Promise<boolean> {
  if (fromKey === toKey) return false;  // 自己ループ禁止
  const rows = await db
    .select({ bidirectional: schema.relayPairs.bidirectional })
    .from(schema.relayPairs)
    .where(
      and(
        eq(schema.relayPairs.isActive, true),
        or(
          and(
            eq(schema.relayPairs.fromProjectKey, fromKey),
            eq(schema.relayPairs.toProjectKey, toKey),
          ),
          and(
            eq(schema.relayPairs.fromProjectKey, toKey),
            eq(schema.relayPairs.toProjectKey, fromKey),
            eq(schema.relayPairs.bidirectional, true),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ─── Public API (WS コマンドから呼ばれる) ────────────────────

export interface RequestPeerResult {
  saWsUrl:    string;
  challenge:  string;
  expiresAt:  number; // Unix ms
}

/** A から B への呼び出し準備. 成功時は challenge と B の SA URL を返す. */
export async function requestPeer(
  issuerKey: string,
  targetKey: string,
): Promise<RequestPeerResult> {
  if (!(await isPairAllowed(issuerKey, targetKey))) {
    throw new RelayError(
      "pair_not_allowed",
      `relay pair ${issuerKey} → ${targetKey} is not registered or inactive`,
    );
  }
  const saWsUrl = endpoints.get(targetKey);
  if (!saWsUrl) {
    throw new RelayError(
      "target_offline",
      `target project ${targetKey} has not registered an SA endpoint`,
    );
  }
  sweepExpired(Date.now());
  const challenge = newChallenge();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  challenges.set(challenge, { challenge, issuerKey, targetKey, expiresAt });
  return { saWsUrl, challenge, expiresAt };
}

/**
 * B が A から受信した challenge を Cernere に問い合わせて検証.
 *   - challenge が store にあるか
 *   - issuerKey (A が JWT から主張してきた projectKey) と store の issuer が一致するか
 *   - targetKey (B 自身の projectKey = WS セッション bind) と store の target が一致するか
 *   - 期限切れではないか
 *
 * 成功時は challenge を consume (単発使用) して OK を返す.
 */
export function verifyChallenge(
  challenge: string,
  issuerKey: string,
  targetKey: string,
): { valid: true } {
  const record = challenges.get(challenge);
  if (!record) {
    throw new RelayError("challenge_unknown", "challenge not found");
  }
  // consume するか TTL 切れならまずは常に削除
  challenges.delete(challenge);
  if (record.expiresAt <= Date.now()) {
    throw new RelayError("challenge_expired", "challenge expired");
  }
  if (record.issuerKey !== issuerKey) {
    throw new RelayError(
      "challenge_issuer_mismatch",
      `expected issuer ${record.issuerKey}, got ${issuerKey}`,
    );
  }
  if (record.targetKey !== targetKey) {
    throw new RelayError(
      "challenge_target_mismatch",
      `expected target ${record.targetKey}, got ${targetKey}`,
    );
  }
  return { valid: true };
}

// ─── テスト・デバッグ用 ────────────────────────────────────

export function __clearRelayState(): void {
  endpoints.clear();
  challenges.clear();
}

export function __debugSnapshot(): {
  endpoints: Array<[string, string]>;
  challenges: PendingChallenge[];
} {
  return {
    endpoints:  Array.from(endpoints.entries()),
    challenges: Array.from(challenges.values()),
  };
}
