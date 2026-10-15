/**
 * 同意の権限キーの語彙と、管理者所有の上限 (caps) との対応 (設計書 §3.1)。
 *
 *   identity.basic              常に許可 (user id)。必須固定
 *   profile.<field>             profile_access.read / write
 *   identity_claim.<claim>      identity_claims
 *   user_data.module:<module>   user_data.columns[*].module
 *   oidc.<scope>                oidc_clients.scopes
 *
 * 許可リストに無い値は語彙外として扱う (自由文字列にしない)。
 */

import { PROFILE_READ_FIELDS, PROFILE_WRITE_FIELDS } from "../project/profile-access.js";
import { IDENTITY_CLAIMS } from "../project/schema.js";

export const IDENTITY_BASIC = "identity.basic";

/** OIDC の scope のうち同意の対象にするもの (openid は identity.basic に当たる)。 */
export const OIDC_CONSENT_SCOPES = ["email", "profile"] as const;

const PROFILE_FIELDS: ReadonlySet<string> = new Set<string>([...PROFILE_READ_FIELDS, ...PROFILE_WRITE_FIELDS]);
const CLAIMS: ReadonlySet<string> = new Set<string>(IDENTITY_CLAIMS);
const OIDC_SCOPES: ReadonlySet<string> = new Set<string>(OIDC_CONSENT_SCOPES);

export type PermissionKind = "identity" | "profile" | "identity_claim" | "user_data" | "oidc";

export interface ParsedPermissionKey {
  kind: PermissionKind;
  /** profile のフィールド名 / claim 名 / module 名 / scope 名。identity.basic は "basic" */
  name: string;
}

/** 管理者が決めた「サービスが読めてよい上限」。同意はこの内側でだけ効く。 */
export interface ConsentCaps {
  profileFields: string[];
  identityClaims: string[];
  userDataModules: string[];
  oidcScopes: string[];
}

export const EMPTY_CAPS: ConsentCaps = { profileFields: [], identityClaims: [], userDataModules: [], oidcScopes: [] };

/** 語彙内のキーなら分解して返す。語彙外は null。 */
export function parsePermissionKey(key: string): ParsedPermissionKey | null {
  if (key === IDENTITY_BASIC) return { kind: "identity", name: "basic" };
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const prefix = key.slice(0, dot);
  const name = key.slice(dot + 1);
  switch (prefix) {
    case "profile": return PROFILE_FIELDS.has(name) ? { kind: "profile", name } : null;
    case "identity_claim": return CLAIMS.has(name) ? { kind: "identity_claim", name } : null;
    case "oidc": return OIDC_SCOPES.has(name) ? { kind: "oidc", name } : null;
    case "user_data": {
      if (!name.startsWith("module:")) return null;
      const module = name.slice("module:".length);
      return /^[A-Za-z0-9_-]{1,64}$/.test(module) ? { kind: "user_data", name: module } : null;
    }
    default: return null;
  }
}

/** 上限の内側か。identity.basic は常に内側。 */
export function isWithinCaps(parsed: ParsedPermissionKey, caps: ConsentCaps): boolean {
  switch (parsed.kind) {
    case "identity": return true;
    case "profile": return caps.profileFields.includes(parsed.name);
    case "identity_claim": return caps.identityClaims.includes(parsed.name);
    case "user_data": return caps.userDataModules.includes(parsed.name);
    case "oidc": return caps.oidcScopes.includes(parsed.name);
  }
}

/** 上限で許可されている権限キーの一覧 (identity.basic を除く)。未宣言サービスの表示 (§3.3) に使う。 */
export function permissionKeysWithinCaps(caps: ConsentCaps): string[] {
  return [
    ...caps.profileFields.map((f) => `profile.${f}`),
    ...caps.identityClaims.map((c) => `identity_claim.${c}`),
    ...caps.userDataModules.map((m) => `user_data.module:${m}`),
    ...caps.oidcScopes.map((s) => `oidc.${s}`),
  ];
}

/** managed_projects.schema_definition から上限を導く (管理者所有フィールドだけを見る)。 */
export function capsFromProjectDefinition(definition: unknown): ConsentCaps {
  const def = (definition && typeof definition === "object" ? definition : {}) as {
    profile_access?: { read?: unknown; write?: unknown };
    identity_claims?: unknown;
    user_data?: { columns?: Record<string, { module?: unknown; _deleted?: unknown }> };
  };
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string") : [];
  const profileFields = [...new Set([...strings(def.profile_access?.read), ...strings(def.profile_access?.write)])]
    .filter((f) => PROFILE_FIELDS.has(f));
  const identityClaims = strings(def.identity_claims).filter((c) => CLAIMS.has(c));
  const modules = Object.values(def.user_data?.columns ?? {})
    .filter((column) => column && column._deleted !== true && typeof column.module === "string")
    .map((column) => column.module as string);
  return { profileFields, identityClaims, userDataModules: [...new Set(modules)].sort(), oidcScopes: [] };
}

/** oidc_clients.scopes から上限を導く。OIDC client は oidc.* だけを持つ。 */
export function capsFromOidcScopes(scopes: readonly string[]): ConsentCaps {
  return { ...EMPTY_CAPS, oidcScopes: scopes.filter((s) => OIDC_SCOPES.has(s)) };
}
