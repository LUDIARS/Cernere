/**
 * 連携の判定規則 (spec/plan/2026-10-15-account-federation-design.md §7)。
 * 番号: 未連携は自分の id / 連携は founder の id / 主を替えても不変 / 外れたら自分の id。
 */
import { describe, expect, it } from "vitest";

import {
  FEDERATION_MAX_ACCOUNTS,
  checkJoinCode,
  decideFederationJoin,
  decideFederationRemoval,
  decideSetPrimary,
  pickServiceSubject,
  type FederationMembership,
} from "../../src/federation/policy.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FED = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const membership = (primary: string): FederationMembership => ({ federationId: FED, subjectId: A, primaryUserId: primary });

describe("pickServiceSubject — サービスへ渡す番号", () => {
  it("未連携のアカウントは自分の id", () => {
    expect(pickServiceSubject(B, null, false)).toEqual({ subject: B, primaryUserId: B, federationId: null, detachedFounder: false });
  });

  it("連携しているアカウントは founder の id (連携番号)、名前は主から", () => {
    expect(pickServiceSubject(B, membership(A), false)).toMatchObject({ subject: A, primaryUserId: A, federationId: FED });
  });

  it("主を替えても番号は変わらない", () => {
    expect(pickServiceSubject(B, membership(C), false)).toMatchObject({ subject: A, primaryUserId: C });
    expect(pickServiceSubject(A, membership(C), false).subject).toBe(A);
  });

  it("連携から外れたら自分の id に戻る", () => {
    expect(pickServiceSubject(B, null, false).subject).toBe(B);
  });

  it("連携番号を残したまま外れた founder はサービスへ入れない印を付ける", () => {
    expect(pickServiceSubject(A, null, true)).toMatchObject({ subject: A, detachedFounder: true });
  });
});

describe("decideFederationJoin — 連携への加入", () => {
  const base = { approverUserId: A, joinerUserId: B, approverMembership: null, memberCount: 0, joinerFederated: false, joinerOwnsSubject: false };

  it("承認者が未連携なら承認者を founder として作り、番号は承認者の id", () => {
    expect(decideFederationJoin(base)).toEqual({ ok: true, createFederation: true, subjectId: A, memberCountAfter: 2 });
  });

  it("既にある連携へは連携番号のまま加える", () => {
    expect(decideFederationJoin({ ...base, approverUserId: C, approverMembership: membership(A), memberCount: 2 }))
      .toEqual({ ok: true, createFederation: false, subjectId: A, memberCountAfter: 3 });
  });

  it("上限 10 アカウントを超えない", () => {
    expect(decideFederationJoin({ ...base, approverMembership: membership(A), memberCount: FEDERATION_MAX_ACCOUNTS - 1 }).ok).toBe(true);
    expect(decideFederationJoin({ ...base, approverMembership: membership(A), memberCount: FEDERATION_MAX_ACCOUNTS }))
      .toEqual({ ok: false, reason: "federation_full" });
  });

  it("既に連携済みのアカウントは加えない", () => {
    expect(decideFederationJoin({ ...base, joinerFederated: true })).toEqual({ ok: false, reason: "joiner_already_federated" });
  });

  it("他の連携の番号を持つアカウント (外れた founder) は加えない", () => {
    expect(decideFederationJoin({ ...base, joinerOwnsSubject: true })).toEqual({ ok: false, reason: "joiner_owns_subject" });
  });

  it("自分自身とは連携しない", () => {
    expect(decideFederationJoin({ ...base, joinerUserId: A })).toEqual({ ok: false, reason: "self" });
  });
});

describe("decideSetPrimary — 主の切替", () => {
  const base = { actorUserId: A, primaryUserId: A, candidateUserId: B, memberUserIds: [A, B], revision: 3, expectedRevision: 3 };

  it("現在の主がメンバーへ切り替えると revision が 1 進む", () => {
    expect(decideSetPrimary(base)).toEqual({ ok: true, nextRevision: 4 });
  });

  it("expected revision が古ければ競合として拒否する", () => {
    expect(decideSetPrimary({ ...base, expectedRevision: 2 })).toEqual({ ok: false, reason: "revision_conflict" });
  });

  it("主でないアカウントは切り替えられない", () => {
    expect(decideSetPrimary({ ...base, actorUserId: B })).toEqual({ ok: false, reason: "not_primary" });
  });

  it("連携の外のアカウントは主にできない", () => {
    expect(decideSetPrimary({ ...base, candidateUserId: C })).toEqual({ ok: false, reason: "not_member" });
  });
});

describe("decideFederationRemoval — 外す / 離脱", () => {
  const base = { actorUserId: A, targetUserId: B, primaryUserId: A, memberUserIds: [A, B, C], revision: 1, expectedRevision: 1 };

  it("主は他のアカウントを外せる", () => {
    expect(decideFederationRemoval(base)).toEqual({ ok: true, action: "remove", closes: false, nextPrimaryUserId: null, nextRevision: 2 });
  });

  it("本人は離脱できるが、主でなければ他人を外せない", () => {
    expect(decideFederationRemoval({ ...base, actorUserId: B })).toMatchObject({ ok: true, action: "leave" });
    expect(decideFederationRemoval({ ...base, actorUserId: B, targetUserId: C })).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("主が離脱すると残りの最も古いアカウントが主になる", () => {
    expect(decideFederationRemoval({ ...base, targetUserId: A })).toMatchObject({ ok: true, nextPrimaryUserId: B, closes: false });
  });

  it("最後の 1 つになったら連携を閉じる", () => {
    expect(decideFederationRemoval({ ...base, memberUserIds: [A, B] })).toMatchObject({ ok: true, closes: true, nextPrimaryUserId: null });
  });

  it("revision が古ければ拒否する", () => {
    expect(decideFederationRemoval({ ...base, expectedRevision: 0 })).toEqual({ ok: false, reason: "revision_conflict" });
  });
});

describe("checkJoinCode — 4 桁の照合", () => {
  it("一致したときだけ match", () => {
    expect(checkJoinCode("0427", "0427", 0)).toBe("match");
  });

  it("不一致は 3 回目で失効させる", () => {
    expect(checkJoinCode("0427", "0428", 0)).toBe("retry");
    expect(checkJoinCode("0427", "0428", 1)).toBe("retry");
    expect(checkJoinCode("0427", "0428", 2)).toBe("locked");
  });

  it("形の崩れたコード (空・桁違い) は一致させない", () => {
    expect(checkJoinCode("", "", 0)).toBe("retry");
    expect(checkJoinCode("0427", "04270", 0)).toBe("retry");
  });
});
