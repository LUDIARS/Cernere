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
    teamDomain: p.teamDomain === undefined ? current.teamDomain : requireNonEmpty(p.teamDomain, "teamDomain"),
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
    defaultRole: p.defaultRole === undefined ? current.defaultRole : requireNonEmpty(p.defaultRole, "defaultRole"),
    adminGroups: p.adminGroups === undefined
      ? current.adminGroups
      : parseStringList(p.adminGroups, "adminGroups", false),
    fetchIdentity: p.fetchIdentity === undefined ? current.fetchIdentity : Boolean(p.fetchIdentity),
    requireDeviceCheck: p.requireDeviceCheck === undefined
      ? current.requireDeviceCheck
      : Boolean(p.requireDeviceCheck),
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
    teamDomain: requireNonEmpty(p.teamDomain, "teamDomain"),
    audTags: parseStringList(p.audTags, "audTags", true),
    allowedEmailDomains: parseStringList(p.allowedEmailDomains, "allowedEmailDomains", true),
    provisioning: parseProvisioning(p.provisioning),
    subjectClaim: p.subjectClaim === undefined || p.subjectClaim === null
      ? null
      : requireNonEmpty(p.subjectClaim, "subjectClaim"),
    defaultRole: p.defaultRole === undefined ? "general" : requireNonEmpty(p.defaultRole, "defaultRole"),
    adminGroups: p.adminGroups === undefined ? [] : parseStringList(p.adminGroups, "adminGroups", false),
    fetchIdentity: p.fetchIdentity === undefined ? true : Boolean(p.fetchIdentity),
    requireDeviceCheck: p.requireDeviceCheck === undefined ? false : Boolean(p.requireDeviceCheck),
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

/**
 * 文字列配列を取り出す。
 *
 * `allowedEmailDomains` と `audTags` は **空配列を許さない**。 前者は CF 側
 * ポリシーの設定ミスに対する二重化なので、 空にすると防御が 1 枚減る。
 */
function parseStringList(value: unknown, field: string, requireNonEmptyList: boolean): string[] {
  if (!Array.isArray(value)) throw AppError.badRequest(`${field} must be an array`);
  const list = value.map((v) => String(v).trim().toLowerCase()).filter((v) => v !== "");
  if (requireNonEmptyList && list.length === 0) {
    throw AppError.badRequest(`${field} must not be empty`);
  }
  return list;
}

function parseProvisioning(value: unknown): ProvisioningMode {
  const mode = typeof value === "string" ? value.trim() : "";
  if (!PROVISIONING_MODES.includes(mode as ProvisioningMode)) {
    throw AppError.badRequest(`provisioning must be one of ${PROVISIONING_MODES.join(" / ")}`);
  }
  return mode as ProvisioningMode;
}
