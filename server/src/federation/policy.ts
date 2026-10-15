import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:9502d217 */
import augurContract_5fd9bc14 from './contracts/service-subject.contract.js'; /* augur-inject:contract-predicate:b1725623 */
import augurContract_6c4b3faf from './contracts/join.contract.js'; /* augur-inject:contract-predicate:fae5631d */
import augurContract_25677fd7 from './contracts/set-primary.contract.js'; /* augur-inject:contract-predicate:31e780c2 */
import augurContract_5ac6b7b2 from './contracts/removal.contract.js'; /* augur-inject:contract-predicate:f432a808 */
import augurContract_47cb69e5 from './contracts/join-code.contract.js'; /* augur-inject:contract-predicate:77419790 */
/**
 * アカウント連携 (フェデレーション) の判定規則 (spec/plan/2026-10-15-account-federation-design.md)。
 *
 * DB にも Redis にも触れない純粋関数だけを置く。store / join-request はここの判定に従って書き込む。
 */

/** 1 連携に入れるアカウントの上限 (§2)。 */
export const FEDERATION_MAX_ACCOUNTS = 10;

/** 連携に入った経路 (account_federation_members.joined_via)。 */
export type FederationJoinVia = "founder" | "qr_new_device" | "qr_existing_account";

/** あるアカウントの連携の状況。連携していなければ membership は null。 */
export interface FederationMembership {
  federationId: string;
  subjectId: string;
  primaryUserId: string;
}

export interface ServiceSubject {
  /** サービスへ渡す利用者番号 */
  subject: string;
  /** 名前・プロフィール・許可状態の基準にするアカウント */
  primaryUserId: string;
  federationId: string | null;
  /**
   * 連携の番号 (= 自分の user id) を残したまま連携から外れた founder。
   * 自分の id のままサービスへ入ると連携のデータが見えてしまうので、サービスへは入れない (§4.3)。
   */
  detachedFounder: boolean;
}

/**
 * サービス境界の利用者番号を決める (§3)。
 * 未連携は自分の id、連携中は連携番号 (subject_id)。主は連携の primary_user_id。
 * `ownsForeignSubject` は「自分の id がどこかの連携の番号で、その連携に属していない」こと。
 */
export function pickServiceSubject(
  userId: string,
  membership: FederationMembership | null,
  ownsForeignSubject: boolean,
): ServiceSubject {
  if (membership) {
    return {
      subject: membership.subjectId,
      primaryUserId: membership.primaryUserId,
      federationId: membership.federationId,
      detachedFounder: false,
    };
  }
  return { subject: userId, primaryUserId: userId, federationId: null, detachedFounder: ownsForeignSubject };
}
// @ts-expect-error augur-inject
pickServiceSubject = contract(pickServiceSubject, { ...augurContract_5fd9bc14, contractId: 'C-31', mode: 'observe', sample: 1, where: 'server/src/federation/policy.ts:38', rule: 'contract-wrap', id: '5fd9bc14' }); /* augur-inject:contract-wrap:5fd9bc14 */

export type JoinRefusal =
  | "self"
  | "joiner_already_federated"
  | "joiner_owns_subject"
  | "federation_full";

export interface JoinInput {
  approverUserId: string;
  joinerUserId: string;
  /** 承認者の連携 (無ければ承認者を founder として作る) */
  approverMembership: FederationMembership | null;
  /** 承認者の連携の今の人数 (連携が無ければ 0) */
  memberCount: number;
  /** 加わる側が既にどこかの連携に入っているか */
  joinerFederated: boolean;
  /** 加わる側の id がどこかの連携の番号か (外れた founder)。入れると番号の解決が二重になる */
  joinerOwnsSubject: boolean;
}

export type JoinDecision =
  | { ok: true; createFederation: boolean; subjectId: string; memberCountAfter: number }
  | { ok: false; reason: JoinRefusal };

/**
 * 連携へ加えてよいかを決める。上限 10・既に連携済み・他の連携の番号を持つアカウントは拒否する (§2 / §7)。
 * 承認者が連携していなければ承認者を founder として作り、連携番号は承認者の user id になる (§4.1-4)。
 */
export function decideFederationJoin(input: JoinInput): JoinDecision {
  if (input.approverUserId === input.joinerUserId) return { ok: false, reason: "self" };
  if (input.joinerFederated) return { ok: false, reason: "joiner_already_federated" };
  if (input.joinerOwnsSubject) return { ok: false, reason: "joiner_owns_subject" };
  const createFederation = input.approverMembership === null;
  const current = createFederation ? 1 : input.memberCount;
  if (current + 1 > FEDERATION_MAX_ACCOUNTS) return { ok: false, reason: "federation_full" };
  return {
    ok: true,
    createFederation,
    subjectId: input.approverMembership?.subjectId ?? input.approverUserId,
    memberCountAfter: current + 1,
  };
}
// @ts-expect-error augur-inject
decideFederationJoin = contract(decideFederationJoin, { ...augurContract_6c4b3faf, contractId: 'C-32', mode: 'observe', sample: 1, where: 'server/src/federation/policy.ts:81', rule: 'contract-wrap', id: '6c4b3faf' }); /* augur-inject:contract-wrap:6c4b3faf */

export type SetPrimaryRefusal = "not_primary" | "not_member" | "revision_conflict" | "unchanged";

export interface SetPrimaryInput {
  actorUserId: string;
  primaryUserId: string;
  candidateUserId: string;
  memberUserIds: readonly string[];
  revision: number;
  expectedRevision: number;
}

export type SetPrimaryDecision =
  | { ok: true; nextRevision: number }
  | { ok: false; reason: SetPrimaryRefusal };

/** 主の切替は現在の主だけが、連携のメンバーへ、expected revision が一致したときだけ行える (§4.3)。 */
export function decideSetPrimary(input: SetPrimaryInput): SetPrimaryDecision {
  if (input.actorUserId !== input.primaryUserId) return { ok: false, reason: "not_primary" };
  if (!input.memberUserIds.includes(input.candidateUserId)) return { ok: false, reason: "not_member" };
  if (input.revision !== input.expectedRevision) return { ok: false, reason: "revision_conflict" };
  if (input.candidateUserId === input.primaryUserId) return { ok: false, reason: "unchanged" };
  return { ok: true, nextRevision: input.revision + 1 };
}
// @ts-expect-error augur-inject
decideSetPrimary = contract(decideSetPrimary, { ...augurContract_25677fd7, contractId: 'C-33', mode: 'observe', sample: 1, where: 'server/src/federation/policy.ts:112', rule: 'contract-wrap', id: '25677fd7' }); /* augur-inject:contract-wrap:25677fd7 */

export type RemovalRefusal = "not_member" | "not_allowed" | "revision_conflict";

export interface RemovalInput {
  actorUserId: string;
  targetUserId: string;
  primaryUserId: string;
  /** joined_at の古い順 */
  memberUserIds: readonly string[];
  revision: number;
  expectedRevision: number;
}

export type RemovalDecision =
  | {
    ok: true;
    action: "leave" | "remove";
    /** 残りが 1 つ以下になったら連携を閉じる */
    closes: boolean;
    /** 主が外れるときの次の主 (閉じるときと主が残るときは null) */
    nextPrimaryUserId: string | null;
    nextRevision: number;
  }
  | { ok: false; reason: RemovalRefusal };

/**
 * アカウントを連携から外す。本人の離脱か主による取り外しだけを許す (§4.3)。
 * 主が外れるときは残りのうち最も古いアカウントを主にする。残りが 1 つ以下なら連携を閉じる。
 */
export function decideFederationRemoval(input: RemovalInput): RemovalDecision {
  if (!input.memberUserIds.includes(input.targetUserId) || !input.memberUserIds.includes(input.actorUserId)) {
    return { ok: false, reason: "not_member" };
  }
  const leaving = input.actorUserId === input.targetUserId;
  if (!leaving && input.actorUserId !== input.primaryUserId) return { ok: false, reason: "not_allowed" };
  if (input.revision !== input.expectedRevision) return { ok: false, reason: "revision_conflict" };
  const remaining = input.memberUserIds.filter((id) => id !== input.targetUserId);
  const closes = remaining.length <= 1;
  const nextPrimaryUserId = !closes && input.targetUserId === input.primaryUserId ? remaining[0] : null;
  return {
    ok: true,
    action: leaving ? "leave" : "remove",
    closes,
    nextPrimaryUserId,
    nextRevision: input.revision + 1,
  };
}
// @ts-expect-error augur-inject
decideFederationRemoval = contract(decideFederationRemoval, { ...augurContract_5ac6b7b2, contractId: 'C-34', mode: 'observe', sample: 1, where: 'server/src/federation/policy.ts:148', rule: 'contract-wrap', id: '5ac6b7b2' }); /* augur-inject:contract-wrap:5ac6b7b2 */

/** 4 桁の確認コードを何回まで間違えてよいか。超えたら引き継ぎ要求を失効させる。 */
export const JOIN_CODE_MAX_ATTEMPTS = 3;

export type JoinCodeCheck = "match" | "retry" | "locked";

/**
 * 確認コードの照合。4 桁の数字で、期待値と定数時間で一致したときだけ match。
 * 外れたら試行回数を数え、上限に達したら locked (要求を失効させる)。
 */
export function checkJoinCode(expected: string, actual: string, previousAttempts: number): JoinCodeCheck {
  const wellFormed = /^\d{4}$/.test(expected) && /^\d{4}$/.test(actual);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  if (wellFormed && diff === 0) return "match";
  return previousAttempts + 1 >= JOIN_CODE_MAX_ATTEMPTS ? "locked" : "retry";
}
// @ts-expect-error augur-inject
checkJoinCode = contract(checkJoinCode, { ...augurContract_47cb69e5, contractId: 'C-35', mode: 'observe', sample: 1, where: 'server/src/federation/policy.ts:176', rule: 'contract-wrap', id: '47cb69e5' }); /* augur-inject:contract-wrap:47cb69e5 */
