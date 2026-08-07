/**
 * エッジ IdP binding ストア (edge_idp_bindings)
 *
 * spec/feature/edge-assertion-login.md §10 / §11。
 *
 * 「どの project が、 どの Cloudflare Access アプリからのアサーションを
 * 受理してよいか」 を管理する。 binding が無い project からの
 * `auth.edge_assertion` は無条件で拒否する (fail-closed)。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";

export type ProvisioningMode = "auto" | "link_only" | "invite_only";

export interface EdgeIdpBinding {
  projectKey: string;
  provider: string;
  teamDomain: string;
  audTags: string[];
  subjectClaim: string | null;
  allowedEmailDomains: string[];
  provisioning: ProvisioningMode;
  defaultRole: string;
  adminGroups: string[];
  fetchIdentity: boolean;
  requireDeviceCheck: boolean;
  isActive: boolean;
  createdAt: string;
}

const PROVISIONING_MODES: ProvisioningMode[] = ["auto", "link_only", "invite_only"];

/** Cernere の system role (CLAUDE.md §1.2 Step 5)。 未知の値は role 判定に効かない。 */
const SYSTEM_ROLES = ["general", "admin"];

/**
 * `<team>.cloudflareaccess.com` 限定。
 *
 * team_domain は JWKS 取得先と get-identity の宛先にそのまま入る。 任意ホストを
 * 許すと、 binding の設定ミス 1 つで利用者の `CF_Authorization` クッキーを
 * 外部へ転送してしまう。 spec §10 の形に固定して事故を構造的に潰す。
 */
const TEAM_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

function toBinding(row: typeof schema.edgeIdpBindings.$inferSelect): EdgeIdpBinding {
  return {
    projectKey: row.projectKey,
    provider: row.provider,
    teamDomain: row.teamDomain,
    audTags: (row.audTags as string[]) ?? [],
    subjectClaim: row.subjectClaim,
    allowedEmailDomains: (row.allowedEmailDomains as string[]) ?? [],
    provisioning: row.provisioning as ProvisioningMode,
    defaultRole: row.defaultRole,
    adminGroups: (row.adminGroups as string[]) ?? [],
    fetchIdentity: row.fetchIdentity,
    requireDeviceCheck: row.requireDeviceCheck,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 有効な binding だけを返す。 未登録・無効なら null。 */
export async function getActiveBinding(projectKey: string): Promise<EdgeIdpBinding | null> {
  const rows = await db.select().from(schema.edgeIdpBindings)
    .where(eq(schema.edgeIdpBindings.projectKey, projectKey)).limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return toBinding(row);
}

export async function listBindings(): Promise<EdgeIdpBinding[]> {
  const rows = await db.select().from(schema.edgeIdpBindings);
  return rows.map(toBinding);
}

export interface BindingInput {
  projectKey: string;
  teamDomain: string;
  audTags: string[];
  allowedEmailDomains: string[];
  provisioning: ProvisioningMode;
  subjectClaim?: string | null;
  defaultRole?: string;
  adminGroups?: string[];
  fetchIdentity?: boolean;
  requireDeviceCheck?: boolean;
}

export async function registerBinding(payload: unknown): Promise<EdgeIdpBinding> {
  const input = parseInput(payload);
  const existing = await db.select({ key: schema.edgeIdpBindings.projectKey })
    .from(schema.edgeIdpBindings)
    .where(eq(schema.edgeIdpBindings.projectKey, input.projectKey)).limit(1);
  if (existing.length > 0) {
    throw AppError.conflict(`binding already exists for project ${input.projectKey}`);
  }

  await db.insert(schema.edgeIdpBindings).values({
    projectKey: input.projectKey,
    provider: "cf_access",
    teamDomain: input.teamDomain,
    audTags: input.audTags,
    subjectClaim: input.subjectClaim ?? null,
    allowedEmailDomains: input.allowedEmailDomains,
    provisioning: input.provisioning,
    defaultRole: input.defaultRole ?? "general",
    adminGroups: input.adminGroups ?? [],
    fetchIdentity: input.fetchIdentity ?? true,
    requireDeviceCheck: input.requireDeviceCheck ?? false,
    isActive: true,
  });

  const created = await getBindingOrThrow(input.projectKey);
  return created;
}

export async function updateBinding(projectKey: string, payload: unknown): Promise<EdgeIdpBinding> {
  const current = await getBindingOrThrow(projectKey);
  const p = asObject(payload);

  const merged: BindingInput = {
    projectKey,
    teamDomain: p.teamDomain === undefined ? current.teamDomain : parseTeamDomain(p.teamDomain),
    audTags: p.audTags === undefined ? current.audTags : parseStringList(p.audTags, "audTags", true),
    allowedEmailDomains: p.allowedEmailDomains === undefined
      ? current.allowedEmailDomains
      : parseStringList(p.allowedEmailDomains, "allowedEmailDomains", true),
    provisioning: p.provisioning === undefined
      ? current.provisioning
      : parseProvisioning(p.provisioning),
    subjectClaim: p.subjectClaim === undefined
      ? current.subjectClaim
      : (p.subjectClaim === null ? null : requireNonEmpty(p.subjectClaim, "subjectClaim")),
    defaultRole: p.defaultRole === undefined ? current.defaultRole : parseDefaultRole(p.defaultRole),
    adminGroups: p.adminGroups === undefined
      ? current.adminGroups
      : parseAdminGroups(p.adminGroups),
    fetchIdentity: p.fetchIdentity === undefined
      ? current.fetchIdentity
      : parseBoolean(p.fetchIdentity, "fetchIdentity"),
    requireDeviceCheck: p.requireDeviceCheck === undefined
      ? current.requireDeviceCheck
      : parseBoolean(p.requireDeviceCheck, "requireDeviceCheck"),
  };

  await db.update(schema.edgeIdpBindings).set({
    teamDomain: merged.teamDomain,
    audTags: merged.audTags,
    subjectClaim: merged.subjectClaim ?? null,
    allowedEmailDomains: merged.allowedEmailDomains,
    provisioning: merged.provisioning,
    defaultRole: merged.defaultRole ?? "general",
    adminGroups: merged.adminGroups ?? [],
    fetchIdentity: merged.fetchIdentity ?? true,
    requireDeviceCheck: merged.requireDeviceCheck ?? false,
  }).where(eq(schema.edgeIdpBindings.projectKey, projectKey));

  return getBindingOrThrow(projectKey);
}

export async function setBindingActive(projectKey: string, isActive: boolean): Promise<EdgeIdpBinding> {
  await getBindingOrThrow(projectKey);
  await db.update(schema.edgeIdpBindings).set({ isActive })
    .where(eq(schema.edgeIdpBindings.projectKey, projectKey));
  return getBindingOrThrow(projectKey);
}

async function getBindingOrThrow(projectKey: string): Promise<EdgeIdpBinding> {
  const rows = await db.select().from(schema.edgeIdpBindings)
    .where(eq(schema.edgeIdpBindings.projectKey, projectKey)).limit(1);
  const row = rows[0];
  if (!row) throw AppError.notFound(`binding not found for project ${projectKey}`);
  return toBinding(row);
}

function parseInput(payload: unknown): BindingInput {
  const p = asObject(payload);
  return {
    projectKey: requireNonEmpty(p.projectKey, "projectKey"),
    teamDomain: parseTeamDomain(p.teamDomain),
    audTags: parseStringList(p.audTags, "audTags", true),
    allowedEmailDomains: parseStringList(p.allowedEmailDomains, "allowedEmailDomains", true),
    provisioning: parseProvisioning(p.provisioning),
    subjectClaim: p.subjectClaim === undefined || p.subjectClaim === null
      ? null
      : requireNonEmpty(p.subjectClaim, "subjectClaim"),
    defaultRole: p.defaultRole === undefined ? "general" : parseDefaultRole(p.defaultRole),
    adminGroups: p.adminGroups === undefined ? [] : parseAdminGroups(p.adminGroups),
    fetchIdentity: p.fetchIdentity === undefined ? true : parseBoolean(p.fetchIdentity, "fetchIdentity"),
    requireDeviceCheck: p.requireDeviceCheck === undefined
      ? false
      : parseBoolean(p.requireDeviceCheck, "requireDeviceCheck"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest("payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.badRequest(`${field} is required`);
  }
  return value.trim();
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw AppError.badRequest(`${field} must be a boolean`);
  }
  return value;
}

function parseAdminGroups(value: unknown): string[] {
  const groups = parseStringList(value, "adminGroups", false);
  if (groups.length > 0) {
    throw AppError.badRequest(
      "adminGroups role mapping is unavailable until edge-managed role provenance is persisted",
    );
  }
  return groups;
}

/**
 * 文字列配列を取り出す。
 *
 * `allowedEmailDomains` と `audTags` は **空配列を許さない**。 前者は CF 側
 * ポリシーの設定ミスに対する二重化なので、 空にすると防御が 1 枚減る。
 *
 * 非文字列の要素は弾く。 `String(v)` で通すと `{}` が `"[object object]"` という
 * 許可ドメイン / AUD tag として静かに登録され、 設定ミスが見えなくなる。
 */
function parseStringList(value: unknown, field: string, requireNonEmptyList: boolean): string[] {
  if (!Array.isArray(value)) throw AppError.badRequest(`${field} must be an array`);
  if (value.some((v) => typeof v !== "string")) {
    throw AppError.badRequest(`${field} must be an array of strings`);
  }
  const list = value.map((v) => (v as string).trim().toLowerCase()).filter((v) => v !== "");
  if (requireNonEmptyList && list.length === 0) {
    throw AppError.badRequest(`${field} must not be empty`);
  }
  return list;
}

function parseTeamDomain(value: unknown): string {
  const domain = requireNonEmpty(value, "teamDomain").toLowerCase();
  if (!TEAM_DOMAIN_RE.test(domain)) {
    throw AppError.badRequest("teamDomain must be <team>.cloudflareaccess.com");
  }
  return domain;
}

/**
 * `default_role` は `users.role` にそのまま入る。 未知の値を入れると
 * 「admin でも general でもない」 ユーザが出来て権限判定が静かに壊れるので、
 * 既知の system role に限定する。
 */
function parseDefaultRole(value: unknown): string {
  const role = requireNonEmpty(value, "defaultRole").toLowerCase();
  if (!SYSTEM_ROLES.includes(role)) {
    throw AppError.badRequest(`defaultRole must be one of ${SYSTEM_ROLES.join(" / ")}`);
  }
  return role;
}

function parseProvisioning(value: unknown): ProvisioningMode {
  const mode = typeof value === "string" ? value.trim() : "";
  if (!PROVISIONING_MODES.includes(mode as ProvisioningMode)) {
    throw AppError.badRequest(`provisioning must be one of ${PROVISIONING_MODES.join(" / ")}`);
  }
  return mode as ProvisioningMode;
}
