/**
 * 引き継ぎ要求 (spec/plan/2026-10-15-account-federation-design.md §4.1 / §4.2)。
 *
 * 2 つの側がある:
 *   device    連携に加わる側。新しい端末 B (未ログイン) か、既存アカウント C (ログイン済み)
 *   approver  連携へ迎える側。使っている端末 A (ログイン済み)。パスキーの action proof で承認する
 *
 * どちらからでも始められる (カメラがある側で読み、無い側で QR を出す):
 *   device 起点    B が要求を作り QR と 4 桁を出す → A が QR を読んで claim → 4 桁を照合して承認
 *   approver 起点  A が招待を作り QR を出す → B が QR を読んで claim (ここで 4 桁が B に出る) → A が照合して承認
 * 承認されたら device 側が完了させる (B はパスキーを作って新しいアカウントで加わる / C はパスキーで本人確認して加わる)。
 *
 * 秘密の扱い: QR の token と device 側の deviceSecret は digest だけを Redis に置く。token は claim で 1 回だけ使え、
 * 要求全体は 10 分で消える。4 桁は 3 回間違えたら要求を失効させる。
 */

import crypto from "node:crypto";

import { AppError } from "../error.js";
import { checkJoinCode } from "./policy.js";

export const JOIN_REQUEST_TTL_SEC = 10 * 60;

export type JoinKind = "new_device" | "existing_account";
export type JoinInitiator = "device" | "approver";
export type JoinState = "open" | "claimed" | "approved" | "completed" | "locked";

export interface JoinRequestRecord {
  id: string;
  kind: JoinKind | null;
  initiator: JoinInitiator;
  state: JoinState;
  approverUserId: string | null;
  /** existing_account のときの加わるアカウント */
  joinerUserId: string | null;
  deviceSecretDigest: string | null;
  code: string | null;
  codeAttempts: number;
  /** device 側の端末の概略 (UA から。表示用の参考情報) */
  device: string | null;
  expiresAt: number;
}

/** テストで差し替えられるよう、使う Redis 操作だけに絞る。 */
export interface JoinRequestRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  setnx(key: string, value: string, ttlMs: number): Promise<boolean>;
}

export const JOIN_REQUEST_EXPIRED = "federation_join_expired";
export const JOIN_CODE_MISMATCH = "federation_join_code_mismatch";
export const JOIN_CODE_LOCKED = "federation_join_code_locked";

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function newSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function newCode(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, "0");
}

function expired(): AppError {
  return AppError.withCode(410, JOIN_REQUEST_EXPIRED, "This sign-in transfer has expired. Start again.");
}

function sameDigest(expected: string | null, secret: string): boolean {
  if (!expected || !secret) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(digest(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface DeviceRequestCreated {
  requestId: string;
  token: string;
  code: string;
  deviceSecret: string;
  expiresIn: number;
}

export interface InviteCreated {
  requestId: string;
  token: string;
  expiresIn: number;
}

export interface DeviceClaimed {
  requestId: string;
  code: string;
  deviceSecret: string;
  kind: JoinKind;
  expiresIn: number;
}

export interface ApproverView {
  requestId: string;
  state: JoinState;
  kind: JoinKind | null;
  device: string | null;
  joinerUserId: string | null;
  expiresIn: number;
}

export class JoinRequestStore {
  constructor(private readonly redis: JoinRequestRedis, private readonly now: () => number = Date.now) {}

  private requestKey(id: string) { return `federation:join:req:${id}`; }
  private tokenKey(token: string) { return `federation:join:tok:${digest(token)}`; }
  private completionKey(id: string) { return `federation:join:done:${id}`; }

  private remainingMs(record: JoinRequestRecord): number {
    return record.expiresAt - this.now();
  }

  private async load(requestId: string): Promise<JoinRequestRecord> {
    const raw = await this.redis.get(this.requestKey(requestId));
    if (!raw) throw expired();
    const record = JSON.parse(raw) as JoinRequestRecord;
    if (this.remainingMs(record) <= 0) throw expired();
    return record;
  }

  private async save(record: JoinRequestRecord): Promise<void> {
    const ttl = this.remainingMs(record);
    if (ttl <= 0) throw expired();
    await this.redis.set(this.requestKey(record.id), JSON.stringify(record), "PX", ttl);
  }

  private async createRecord(record: Omit<JoinRequestRecord, "id" | "expiresAt" | "codeAttempts">): Promise<{ record: JoinRequestRecord; token: string }> {
    const token = newSecret();
    const full: JoinRequestRecord = {
      ...record,
      id: crypto.randomUUID(),
      codeAttempts: 0,
      expiresAt: this.now() + JOIN_REQUEST_TTL_SEC * 1000,
    };
    await this.save(full);
    await this.redis.set(this.tokenKey(token), full.id, "PX", JOIN_REQUEST_TTL_SEC * 1000);
    return { record: full, token };
  }

  /** device 起点: B (未ログイン) または C (ログイン済み) が要求を作る。 */
  async createDeviceRequest(input: { joinerUserId: string | null; device: string | null }): Promise<DeviceRequestCreated> {
    const deviceSecret = newSecret();
    const code = newCode();
    const { record, token } = await this.createRecord({
      kind: input.joinerUserId ? "existing_account" : "new_device",
      initiator: "device",
      state: "open",
      approverUserId: null,
      joinerUserId: input.joinerUserId,
      deviceSecretDigest: digest(deviceSecret),
      code,
      device: input.device,
    });
    return { requestId: record.id, token, code, deviceSecret, expiresIn: JOIN_REQUEST_TTL_SEC };
  }

  /** approver 起点: A (ログイン済み) が招待を作る。4 桁は B が読んだときに作る。 */
  async createInvite(approverUserId: string): Promise<InviteCreated> {
    const { record, token } = await this.createRecord({
      kind: null, initiator: "approver", state: "open", approverUserId,
      joinerUserId: null, deviceSecretDigest: null, code: null, device: null,
    });
    return { requestId: record.id, token, expiresIn: JOIN_REQUEST_TTL_SEC };
  }

  private async consumeToken(token: string): Promise<JoinRequestRecord> {
    if (!token || token.length > 512) throw expired();
    const requestId = await this.redis.getdel(this.tokenKey(token));
    if (!requestId) throw expired();
    const record = await this.load(requestId);
    if (record.state !== "open") throw expired();
    return record;
  }

  /** A が B (または C) の QR を読んだ: token を 1 回だけ使い、承認者を結び付ける。 */
  async claimAsApprover(token: string, approverUserId: string): Promise<ApproverView> {
    const record = await this.consumeToken(token);
    if (record.initiator !== "device") throw expired();
    if (record.joinerUserId === approverUserId) {
      throw AppError.badRequest("Scan this code on another account's device");
    }
    record.approverUserId = approverUserId;
    record.state = "claimed";
    await this.save(record);
    return this.view(record);
  }

  /** B (または C) が A の招待 QR を読んだ: token を 1 回だけ使い、4 桁と deviceSecret を作る。 */
  async claimAsDevice(token: string, input: { joinerUserId: string | null; device: string | null }): Promise<DeviceClaimed> {
    const record = await this.consumeToken(token);
    if (record.initiator !== "approver") throw expired();
    if (input.joinerUserId && input.joinerUserId === record.approverUserId) {
      throw AppError.badRequest("Scan this code on the device you want to add");
    }
    const deviceSecret = newSecret();
    record.kind = input.joinerUserId ? "existing_account" : "new_device";
    record.joinerUserId = input.joinerUserId;
    record.deviceSecretDigest = digest(deviceSecret);
    record.code = newCode();
    record.device = input.device;
    record.state = "claimed";
    await this.save(record);
    return {
      requestId: record.id, code: record.code, deviceSecret, kind: record.kind,
      expiresIn: Math.ceil(this.remainingMs(record) / 1000),
    };
  }

  private view(record: JoinRequestRecord): ApproverView {
    return {
      requestId: record.id,
      state: record.state,
      kind: record.kind,
      device: record.device,
      joinerUserId: record.joinerUserId,
      expiresIn: Math.max(0, Math.ceil(this.remainingMs(record) / 1000)),
    };
  }

  /** A: 自分が承認する要求の状態 (招待を読まれたか、端末の概略)。4 桁は返さない。 */
  async describeForApprover(requestId: string, approverUserId: string): Promise<ApproverView> {
    const record = await this.load(requestId);
    if (record.approverUserId !== approverUserId) throw AppError.notFound("Sign-in transfer not found");
    return this.view(record);
  }

  /**
   * A: device 側に表示された 4 桁を照合して承認する。パスキーの action proof は呼び出し側で消費済み。
   * 3 回間違えたら要求を失効させる。
   */
  async approve(requestId: string, approverUserId: string, code: string): Promise<ApproverView> {
    const record = await this.load(requestId);
    if (record.approverUserId !== approverUserId) throw AppError.notFound("Sign-in transfer not found");
    if (record.state !== "claimed") throw AppError.conflict("This sign-in transfer cannot be approved now");
    const check = checkJoinCode(record.code ?? "", code, record.codeAttempts);
    if (check === "match") {
      record.state = "approved";
      await this.save(record);
      return this.view(record);
    }
    record.codeAttempts += 1;
    if (check === "locked") record.state = "locked";
    await this.save(record);
    if (check === "locked") {
      throw AppError.withCode(409, JOIN_CODE_LOCKED, "The number did not match too many times; start again");
    }
    throw AppError.withCode(400, JOIN_CODE_MISMATCH, "The number does not match the one on the other device");
  }

  /** device 側: 承認されたかを見る (ポーリング)。 */
  async deviceStatus(requestId: string, deviceSecret: string): Promise<{ state: JoinState; kind: JoinKind | null; expiresIn: number }> {
    const record = await this.load(requestId);
    if (!sameDigest(record.deviceSecretDigest, deviceSecret)) throw AppError.notFound("Sign-in transfer not found");
    return { state: record.state, kind: record.kind, expiresIn: Math.max(0, Math.ceil(this.remainingMs(record) / 1000)) };
  }

  /**
   * device 側: 承認済みの要求を完了させる権利を 1 回だけ取る。成功したら finishCompletion、
   * 連携の書き込みが失敗したら abortCompletion を呼ぶ。
   */
  async beginCompletion(requestId: string, deviceSecret: string, joinerUserId: string | null): Promise<JoinRequestRecord> {
    const record = await this.load(requestId);
    if (!sameDigest(record.deviceSecretDigest, deviceSecret)) throw AppError.notFound("Sign-in transfer not found");
    if (record.state !== "approved" || !record.approverUserId) throw AppError.conflict("This sign-in transfer is not approved yet");
    if ((record.joinerUserId ?? null) !== joinerUserId) throw AppError.forbidden("This sign-in transfer belongs to another account");
    if (!await this.redis.setnx(this.completionKey(requestId), "1", Math.max(1, this.remainingMs(record)))) {
      throw AppError.conflict("This sign-in transfer was already used");
    }
    return record;
  }

  async abortCompletion(requestId: string): Promise<void> {
    await this.redis.del(this.completionKey(requestId));
  }

  async finishCompletion(record: JoinRequestRecord): Promise<void> {
    record.state = "completed";
    try { await this.save(record); } catch { /* 期限切れなら記録は不要 (completion key が二重使用を止める) */ }
  }
}

/** QR に載せる URL。token は fragment に載せる (履歴・Referer・プロキシログに残さない)。 */
export function joinRequestUrl(frontendUrl: string, initiator: JoinInitiator, token: string): string {
  const url = new URL(initiator === "device" ? "/federate/approve" : "/federate/join", frontendUrl);
  url.hash = `t=${token}`;
  return url.toString();
}
