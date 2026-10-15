/**
 * 同意の要否と画面の表示データを決める純粋関数 (設計書 §3.2 / §3.3 / §4.1 / §5.2)。
 *
 *   (宣言, 上限, data_sharing, 保存済み同意) → { satisfied, missingRequired, pendingRecommended, view }
 *
 * 全経路 (open_url / popup / silent SSO / project WS / edge / OIDC) がこの 1 か所で判定する。
 */

import type { ConsentDeclaration, ConsentLevel, DeclaredVisibility } from "./declaration-schema.js";
import {
  IDENTITY_BASIC,
  isWithinCaps,
  parsePermissionKey,
  permissionKeysWithinCaps,
  type ConsentCaps,
  type PermissionKind,
} from "./permission-keys.js";
import { PERSONALITY_FIELDS } from "../project/profile-access.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:cffdbf08 */
import augurContract_5a91c440 from './contracts/requirement.contract.js'; /* augur-inject:contract-predicate:f51e23dc */

/** data_sharing で Cernere 自身が他サービスへ渡す先 (サービスは書けない、確定情報)。 */
export interface SharingTarget {
  projectKey: string;
  name: string;
  /** 共有する module。null は全 module */
  modules: string[] | null;
}

export interface ConsentRecordState {
  declarationVersion: number;
  granted: string[];
  denied: string[];
  revoked: boolean;
}

export interface RequirementInput {
  declaration: ConsentDeclaration | null;
  caps: ConsentCaps;
  sharing: SharingTarget[];
  record: ConsentRecordState | null;
}

export type Audience = DeclaredVisibility | "other_services";

export interface AudienceView {
  audience: Audience;
  /** service = サービスの申告 (Cernere は検証できない) / cernere = Cernere が渡している確定情報 */
  source: "service" | "cernere";
  /** other_services の相手の名前 */
  services?: string[];
}

export interface PermissionView {
  key: string;
  kind: PermissionKind;
  level: ConsentLevel;
  /** サービスの申告した目的。未宣言サービスは null */
  purpose: string | null;
  visibleTo: AudienceView[];
  /** 本人以外 (他の利用者・他のサービス・公開) に届く。画面で目立つ印を付ける */
  sharedBeyondSelf: boolean;
  /** プロフィールの公開設定が public のときだけ他人に見える項目 */
  privacyDependent: boolean;
  /** 前回の同意から増えた権限 (再確認時に強調する) */
  isNew: boolean;
  /** 保存済みの判断。未判断は null */
  decision: "granted" | "denied" | null;
}

export interface ConsentView {
  /** 宣言の版。未宣言は 0 */
  version: number;
  declared: boolean;
  /** 保存済みの同意があり、その後に権限が増えた再確認か */
  reconsent: boolean;
  required: PermissionView[];
  recommended: PermissionView[];
}

export interface ConsentRequirement {
  satisfied: boolean;
  /** 許可されていない必須 (1 つでもあればログインできない) */
  missingRequired: string[];
  /** まだ判断していない推奨 */
  pendingRecommended: string[];
  view: ConsentView;
}

interface EffectivePermission {
  key: string;
  level: ConsentLevel;
  purpose: string | null;
  declaredVisibility: DeclaredVisibility[];
}

/** 宣言 (無ければ §3.3 の既定) を上限で絞った、実際に効く権限の一覧。identity.basic は必ず先頭。 */
function effectivePermissions(declaration: ConsentDeclaration | null, caps: ConsentCaps): EffectivePermission[] {
  const basic: EffectivePermission = { key: IDENTITY_BASIC, level: "required", purpose: null, declaredVisibility: [] };
  if (!declaration) {
    // 未宣言: identity.basic だけ必須、上限で許可されている残りは全て推奨 (黙って渡さない)。
    return [basic, ...permissionKeysWithinCaps(caps).map((key) => ({
      key, level: "recommended" as const, purpose: null, declaredVisibility: [],
    }))];
  }
  const declared = declaration.permissions.filter((p) => {
    const parsed = parsePermissionKey(p.key);
    // 保存後に管理者が上限を狭めた権限は渡せないので表示もしない。
    return parsed !== null && isWithinCaps(parsed, caps);
  }).map((p) => ({ key: p.key, level: p.level, purpose: p.purpose, declaredVisibility: p.visible_to }));
  const explicitBasic = declared.find((p) => p.key === IDENTITY_BASIC);
  return [explicitBasic ?? basic, ...declared.filter((p) => p.key !== IDENTITY_BASIC)];
}

function audiences(permission: EffectivePermission, kind: PermissionKind, name: string, sharing: SharingTarget[]): AudienceView[] {
  const views: AudienceView[] = permission.declaredVisibility.map((audience) => ({ audience, source: "service" }));
  if (kind === "user_data") {
    const services = sharing.filter((s) => s.modules === null || s.modules.includes(name)).map((s) => s.name);
    if (services.length > 0) views.push({ audience: "other_services", source: "cernere", services });
  }
  return views;
}

/** 契約 C-24 (server/src/consent/contracts/requirement.contract.ts) は augur inject が包む。 */
export function evaluateConsentRequirement(input: RequirementInput): ConsentRequirement {
  const { record } = input;
  const active = record && !record.revoked ? record : null;
  const granted = new Set(active?.granted ?? []);
  const denied = new Set(active?.denied ?? []);
  const permissions = effectivePermissions(input.declaration, input.caps);

  const views = permissions.map((permission): PermissionView => {
    const parsed = parsePermissionKey(permission.key) ?? { kind: "identity" as const, name: "basic" };
    const visibleTo = audiences(permission, parsed.kind, parsed.name, input.sharing);
    const known = granted.has(permission.key) || denied.has(permission.key);
    return {
      key: permission.key,
      kind: parsed.kind,
      level: permission.level,
      purpose: permission.purpose,
      visibleTo,
      sharedBeyondSelf: visibleTo.some((v) => v.audience !== "self"),
      privacyDependent: parsed.kind === "profile" && PERSONALITY_FIELDS.has(parsed.name),
      isNew: active !== null && !known,
      decision: granted.has(permission.key) ? "granted" : denied.has(permission.key) ? "denied" : null,
    };
  });

  const required = views.filter((v) => v.level === "required");
  const recommended = views.filter((v) => v.level === "recommended");
  // 必須は「許可済み」でなければ不足 (推奨で外した権限が必須に上がった場合も聞き直す)。
  const missingRequired = required.filter((v) => v.decision !== "granted").map((v) => v.key);
  // 推奨は許可・拒否のどちらかが保存されていれば判断済み。必須から推奨へ下がった権限は許可を保つ。
  const pendingRecommended = recommended.filter((v) => v.decision === null).map((v) => v.key);
  const satisfied = missingRequired.length === 0 && pendingRecommended.length === 0;

  return {
    satisfied,
    missingRequired,
    pendingRecommended,
    view: {
      version: input.declaration?.version ?? 0,
      declared: input.declaration !== null,
      reconsent: active !== null && !satisfied,
      required,
      recommended,
    },
  };
}
// @ts-expect-error augur-inject
evaluateConsentRequirement = contract(evaluateConsentRequirement, { ...augurContract_5a91c440, contractId: 'C-24', mode: 'observe', sample: 1, where: 'server/src/consent/requirement.ts:123', rule: 'contract-wrap', id: '5a91c440' }); /* augur-inject:contract-wrap:5a91c440 */

/**
 * 利用者の選択 (許可した推奨) から保存する granted / denied を決める。
 * 必須は全て許可に入る。選択肢に無いキーは無視する (画面の改ざんで上限外を足させない)。
 */
export function resolveDecision(requirement: ConsentRequirement, chosenRecommended: readonly string[]): { granted: string[]; denied: string[] } {
  const chosen = new Set(chosenRecommended);
  const recommended = requirement.view.recommended.map((p) => p.key);
  return {
    granted: [...requirement.view.required.map((p) => p.key), ...recommended.filter((k) => chosen.has(k))],
    denied: recommended.filter((k) => !chosen.has(k)),
  };
}
