/** 登録画面の会場確認 (spec/feature/venue-network-registration.md §2) と審査画面の登録経路の見せ方 (§7)。 */

import { describe, expect, it } from "vitest";
import { phaseAfterSend, phaseAfterStatus, runVenueCheck, venueChallengeForSignup,
  type VenueCheckDeps, type VenueCheckState } from "../../../frontend/src/lib/venue-check";
import { orderedReviewActions, registrationOriginLabel } from "../../../frontend/src/pages/admin/access-review-origin";

const KIOSK = { lanId: "lan-1", placeId: "p", lanUrl: "https://kiosk.lan:8443", label: null };

function fakeDeps(options: { delivered: boolean; statuses: Array<"pending" | "verified" | "expired">; startFails?: boolean }) {
  let clock = 0;
  const statuses = [...options.statuses];
  const deps: VenueCheckDeps = {
    start: async () => {
      if (options.startFails) throw new Error("503");
      return { challengeId: "c-1", nonce: "n-1", expiresAt: new Date(10_000).toISOString(), kiosks: [KIOSK] };
    },
    sendToKiosk: async () => options.delivered,
    status: async () => statuses.shift() ?? "pending",
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return deps;
}

async function run(deps: VenueCheckDeps): Promise<VenueCheckState[]> {
  const seen: VenueCheckState[] = [];
  await runVenueCheck(deps, (s) => seen.push(s), () => false);
  return seen;
}

describe("runVenueCheck", () => {
  it("会場の LAN で kiosk に届けば確認待ちを経て verified になり、signup に challenge を付ける", async () => {
    const seen = await run(fakeDeps({ delivered: true, statuses: ["pending", "verified"] }));
    expect(seen.map((s) => s.phase)).toEqual(["starting", "checking", "verified"]);
    expect(venueChallengeForSignup(seen.at(-1)!)).toBe("c-1");
  });

  it("会場の外 (kiosk に届かない) では Wi-Fi の案内を出し、期限で expired になって challenge を付けない", async () => {
    const seen = await run(fakeDeps({ delivered: false, statuses: [] }));
    expect(seen.map((s) => s.phase)).toEqual(["starting", "unreachable", "expired"]);
    expect(venueChallengeForSignup(seen.at(-1)!)).toBeUndefined();
  });

  it("kiosk が無い (503) ときは unavailable で止まる", async () => {
    const seen = await run(fakeDeps({ delivered: true, statuses: [], startFails: true }));
    expect(seen.map((s) => s.phase)).toEqual(["starting", "unavailable"]);
  });

  it("取り消したら画面を更新しない", async () => {
    const seen: VenueCheckState[] = [];
    await runVenueCheck(fakeDeps({ delivered: true, statuses: ["verified"] }), (s) => seen.push(s), () => true);
    expect(seen).toEqual([]);
  });
});

describe("venue check の判定", () => {
  it("1 つでも届けば確認待ち", () => {
    expect(phaseAfterSend([false, true])).toBe("checking");
    expect(phaseAfterSend([])).toBe("unreachable");
  });

  it("pending の間は送信時の判断を保つ", () => {
    expect(phaseAfterStatus("pending", "unreachable")).toBe("unreachable");
    expect(phaseAfterStatus("verified", "unreachable")).toBe("verified");
  });
});

describe("審査画面の登録経路", () => {
  const actions = [
    { decision: "approve" as const, label: "許可する", reason: "verified_out_of_band" },
    { decision: "reject" as const, label: "拒否する", reason: "not_verified" },
  ];

  it("会場外からの登録は例外と表示し、拒否を先頭・既定にする", () => {
    expect(registrationOriginLabel({ registrationOrigin: "outside_venue", exception: true })).toBe("会場外からの登録 (例外)");
    expect(orderedReviewActions({ defaultDecision: "reject" }, actions))
      .toEqual([{ action: actions[1], primary: true }, { action: actions[0], primary: false }]);
  });

  it("既定が無ければ従来どおり許可を強調する", () => {
    expect(registrationOriginLabel({ registrationOrigin: null, exception: false })).toBeNull();
    expect(orderedReviewActions({ defaultDecision: null }, actions))
      .toEqual([{ action: actions[0], primary: true }, { action: actions[1], primary: false }]);
  });
});
