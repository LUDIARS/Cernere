/**
 * 引き継ぎ要求 (spec/plan/2026-10-15-account-federation-design.md §4.1 / §7):
 * token は 1 回限り・10 分で失効・4 桁不一致・承認前は完了できない・完了は 1 回だけ。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { JOIN_REQUEST_TTL_SEC, JoinRequestStore, joinRequestUrl, type JoinRequestRedis } from "../../src/federation/join-request.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class FakeRedis implements JoinRequestRedis {
  values = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly clock: { now: number }) {}
  private live(key: string) {
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= this.clock.now) { this.values.delete(key); return null; }
    return entry.value;
  }
  async get(key: string) { return this.live(key); }
  async set(key: string, value: string, _mode: "PX", ttlMs: number) { this.values.set(key, { value, expiresAt: this.clock.now + ttlMs }); }
  async getdel(key: string) { const v = this.live(key); this.values.delete(key); return v; }
  async del(key: string) { this.values.delete(key); }
  async setnx(key: string, value: string, ttlMs: number) {
    if (this.live(key) !== null) return false;
    await this.set(key, value, "PX", ttlMs);
    return true;
  }
}

let clock: { now: number };
let redis: FakeRedis;
let store: JoinRequestStore;

beforeEach(() => {
  clock = { now: 1_800_000_000_000 };
  redis = new FakeRedis(clock);
  store = new JoinRequestStore(redis, () => clock.now);
});

describe("device 起点 (新しい端末 B が QR を出す)", () => {
  it("A が読んで 4 桁を照合し承認すると、B は 1 回だけ完了できる", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: "Android / Chrome" });
    expect(created.code).toMatch(/^\d{4}$/);
    const claimed = await store.claimAsApprover(created.token, A);
    expect(claimed).toMatchObject({ state: "claimed", kind: "new_device", device: "Android / Chrome" });
    expect(claimed).not.toHaveProperty("code");

    await store.approve(created.requestId, A, created.code);
    expect((await store.deviceStatus(created.requestId, created.deviceSecret)).state).toBe("approved");

    const record = await store.beginCompletion(created.requestId, created.deviceSecret, null);
    expect(record.approverUserId).toBe(A);
    await expect(store.beginCompletion(created.requestId, created.deviceSecret, null)).rejects.toMatchObject({ statusCode: 409 });
    await store.finishCompletion(record);
    expect((await store.deviceStatus(created.requestId, created.deviceSecret)).state).toBe("completed");
  });

  it("連携の書き込みが失敗したら完了権を戻し、やり直せる", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    await store.claimAsApprover(created.token, A);
    await store.approve(created.requestId, A, created.code);
    await store.beginCompletion(created.requestId, created.deviceSecret, null);
    await store.abortCompletion(created.requestId);
    expect((await store.beginCompletion(created.requestId, created.deviceSecret, null)).id).toBe(created.requestId);
  });

  it("token は 1 回限り (2 度目の claim は失効扱い)", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    await store.claimAsApprover(created.token, A);
    await expect(store.claimAsApprover(created.token, A)).rejects.toMatchObject({ code: "federation_join_expired" });
  });

  it("10 分を過ぎた要求は読めない", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    clock.now += JOIN_REQUEST_TTL_SEC * 1000 + 1;
    await expect(store.claimAsApprover(created.token, A)).rejects.toMatchObject({ code: "federation_join_expired" });
  });

  it("4 桁が違えば承認せず、3 回で要求を失効させる", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    await store.claimAsApprover(created.token, A);
    const wrong = created.code === "0000" ? "1111" : "0000";
    await expect(store.approve(created.requestId, A, wrong)).rejects.toMatchObject({ code: "federation_join_code_mismatch" });
    await expect(store.approve(created.requestId, A, wrong)).rejects.toMatchObject({ code: "federation_join_code_mismatch" });
    await expect(store.approve(created.requestId, A, wrong)).rejects.toMatchObject({ code: "federation_join_code_locked" });
    await expect(store.approve(created.requestId, A, created.code)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("承認前は完了できず、deviceSecret が違えば見えない", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    await store.claimAsApprover(created.token, A);
    await expect(store.beginCompletion(created.requestId, created.deviceSecret, null)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.deviceStatus(created.requestId, "x".repeat(43))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("承認者以外は要求を見られず承認もできない", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    await store.claimAsApprover(created.token, A);
    await expect(store.describeForApprover(created.requestId, C)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.approve(created.requestId, C, created.code)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("token・deviceSecret は digest だけを保存する", async () => {
    const created = await store.createDeviceRequest({ joinerUserId: null, device: null });
    const stored = [...redis.values.entries()].map(([k, v]) => `${k}=${v.value}`).join("\n");
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(created.deviceSecret);
  });
});

describe("approver 起点 (A が招待 QR を出す)", () => {
  it("B が読むと 4 桁が B に出て、A は 4 桁で承認する", async () => {
    const invite = await store.createInvite(A);
    const claimed = await store.claimAsDevice(invite.token, { joinerUserId: null, device: "iPhone / Safari" });
    expect(claimed.code).toMatch(/^\d{4}$/);
    expect(await store.describeForApprover(invite.requestId, A)).toMatchObject({ state: "claimed", device: "iPhone / Safari" });
    await store.approve(invite.requestId, A, claimed.code);
    expect((await store.deviceStatus(invite.requestId, claimed.deviceSecret)).state).toBe("approved");
  });

  it("既存アカウント C の完了は C 本人でなければできない (§4.2)", async () => {
    const invite = await store.createInvite(A);
    const claimed = await store.claimAsDevice(invite.token, { joinerUserId: C, device: null });
    expect(claimed.kind).toBe("existing_account");
    await store.approve(invite.requestId, A, claimed.code);
    await expect(store.beginCompletion(invite.requestId, claimed.deviceSecret, null)).rejects.toMatchObject({ statusCode: 403 });
    expect((await store.beginCompletion(invite.requestId, claimed.deviceSecret, C)).joinerUserId).toBe(C);
  });

  it("招待を出したアカウント自身では読めない", async () => {
    const invite = await store.createInvite(A);
    await expect(store.claimAsDevice(invite.token, { joinerUserId: A, device: null })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("joinRequestUrl", () => {
  it("token は fragment に載せる (履歴・Referer・プロキシログに残さない)", () => {
    const url = new URL(joinRequestUrl("https://cernere.example.com", "device", "tok"));
    expect(url.pathname).toBe("/federate/approve");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#t=tok");
    expect(new URL(joinRequestUrl("https://cernere.example.com", "approver", "tok")).pathname).toBe("/federate/join");
  });
});
