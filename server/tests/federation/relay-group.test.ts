/**
 * relay の宛先 (spec/plan/2026-10-15-account-federation-design.md §3):
 * 連携番号でも各アカウントの id でも受け、連携の全アカウントのセッションへ配る。連携の外へは送らない。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/redis.js", () => ({ getSession: async () => null }));

const { sessionRegistry } = await import("../../src/ws/session-registry.js");

const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function fakeWs(received: string[]) {
  return {
    getUserData: () => ({ closed: false }),
    send: (message: string) => { received.push(message); return 1; },
  } as never;
}

const fromA: string[] = [];
const toA2: string[] = [];
const toB: string[] = [];
const toStranger: string[] = [];
sessionRegistry.register("s-a1", SUBJECT, fakeWs(fromA));
sessionRegistry.register("s-a2", SUBJECT, fakeWs(toA2));
sessionRegistry.register("s-b1", B, fakeWs(toB));
sessionRegistry.register("s-x1", STRANGER, fakeWs(toStranger));
const group = { subject: SUBJECT, accountIds: [SUBJECT, B] };

describe("sessionRegistry.relay — 連携のアカウント群", () => {
  it("連携番号宛ては連携の全アカウントのセッションへ届く (送り元には返さない)", async () => {
    expect(sessionRegistry.relay("s-a1", SUBJECT, { user: SUBJECT }, { n: 1 }, group)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(toA2.length).toBe(1);
    expect(toB.length).toBe(1);
    expect(fromA.length).toBe(0);
    expect(toStranger.length).toBe(0);
  });

  it("連携の外のユーザー・セッションは宛先にできない", () => {
    expect(sessionRegistry.relay("s-b1", B, { user: STRANGER }, {}, group)).toBe(false);
    expect(sessionRegistry.relay("s-b1", B, { session: "s-x1" }, {}, group)).toBe(false);
  });

  it("連携していなければ従来どおり自分のセッションだけ", () => {
    expect(sessionRegistry.relay("s-x1", STRANGER, { user: B }, {})).toBe(false);
  });
});
