import crypto from "node:crypto";

import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { ACTION_AUTH_TTL_SECONDS, type ActionTarget } from "./action-policy.js";

export interface ActionProofRecord extends ActionTarget {
  userId: string;
  binding: string;
  issuedAt: string;
}

export interface ActionProofExpectation extends ActionTarget {
  userId: string;
  binding: string;
}

export interface ActionProofRedis {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

interface ActionProofStoreOptions {
  redisClient: ActionProofRedis;
  randomBytes?: (size: number) => Buffer;
  now?: () => Date;
  ttlSeconds?: number;
}

export class ActionProofStore {
  private readonly redisClient: ActionProofRedis;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(options: ActionProofStoreOptions) {
    this.redisClient = options.redisClient;
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? ACTION_AUTH_TTL_SECONDS;
  }

  async issue(expectation: ActionProofExpectation): Promise<{ proof: string; expiresIn: number }> {
    const proof = this.randomBytes(32).toString("base64url");
    const record: ActionProofRecord = {
      ...expectation,
      issuedAt: this.now().toISOString(),
    };
    await this.redisClient.set(proofKey(proof), JSON.stringify(record), "EX", this.ttlSeconds);
    return { proof, expiresIn: this.ttlSeconds };
  }

  async consume(proof: string | undefined, expectation: ActionProofExpectation): Promise<void> {
    if (typeof proof !== "string" || proof.length < 32 || proof.length > 512) {
      throw AppError.forbidden("Action authentication required");
    }
    const raw = await this.redisClient.getdel(proofKey(proof));
    if (!raw) throw AppError.forbidden("Action proof is missing, expired, or already used");

    let record: ActionProofRecord;
    try {
      record = JSON.parse(raw) as ActionProofRecord;
    } catch {
      throw AppError.forbidden("Action proof is invalid");
    }
    if (
      record.userId !== expectation.userId
      || record.binding !== expectation.binding
      || record.action !== expectation.action
      || record.resource !== expectation.resource
    ) {
      throw AppError.forbidden("Action proof does not match this operation");
    }
  }
}

export const actionProofStore = new ActionProofStore({ redisClient: redis });

export function httpActionBinding(bearerToken: string): string {
  return `http:${crypto.createHash("sha256").update(bearerToken).digest("base64url")}`;
}

export function wsActionBinding(sessionId: string): string {
  return `ws:${sessionId}`;
}

function proofKey(proof: string): string {
  const digest = crypto.createHash("sha256").update(proof).digest("base64url");
  return `action-proof:${digest}`;
}
