/**
 * 同意の対象サービスの解決 (設計書 §2 / §4.2)。
 *
 *   projectKey          → managed_projects
 *   target origin       → managed_projects.schema_definition.endpoint.frontend_url の origin で逆引き
 *   OIDC client_id      → oidc_clients
 *
 * 解決結果には判定に要るもの (移行モード・宣言・上限・data_sharing の共有先) をまとめて載せる。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { devLog } from "../logging/dev-logger.js";
import { readConsentDeclaration, readConsentMode, type ConsentDeclaration, type ConsentMode } from "./declaration-schema.js";
import { originOf } from "./continuation.js";
import { capsFromOidcScopes, capsFromProjectDefinition, type ConsentCaps } from "./permission-keys.js";
import type { SharingTarget } from "./requirement.js";
import type { ConsentSubject } from "./store.js";

export interface ResolvedConsentSubject {
  subject: ConsentSubject;
  name: string;
  mode: ConsentMode;
  declaration: ConsentDeclaration | null;
  caps: ConsentCaps;
  sharing: SharingTarget[];
  /** project の frontend_url の origin。継続先の許可に使う */
  frontendOrigin: string | null;
}

type ProjectRow = typeof schema.managedProjects.$inferSelect;

interface DefinitionShape {
  consent?: unknown;
  consent_mode?: unknown;
  endpoint?: { frontend_url?: unknown };
  data_sharing?: Array<{ project_key?: unknown; modules?: unknown }>;
}

function definitionOf(row: ProjectRow): DefinitionShape {
  const def = row.schemaDefinition;
  return def && typeof def === "object" ? def as DefinitionShape : {};
}

function frontendOriginOf(def: DefinitionShape): string | null {
  return typeof def.endpoint?.frontend_url === "string" ? originOf(def.endpoint.frontend_url) : null;
}

async function sharingTargets(def: DefinitionShape): Promise<SharingTarget[]> {
  const shares = Array.isArray(def.data_sharing) ? def.data_sharing : [];
  const targets: SharingTarget[] = [];
  for (const share of shares) {
    if (typeof share.project_key !== "string") continue;
    const rows = await db.select({ name: schema.managedProjects.name }).from(schema.managedProjects)
      .where(eq(schema.managedProjects.key, share.project_key)).limit(1);
    targets.push({
      projectKey: share.project_key,
      name: rows[0]?.name ?? share.project_key,
      modules: Array.isArray(share.modules) && share.modules.length > 0
        ? share.modules.filter((m): m is string => typeof m === "string") : null,
    });
  }
  return targets;
}

async function fromProjectRow(row: ProjectRow): Promise<ResolvedConsentSubject> {
  const def = definitionOf(row);
  return {
    subject: { kind: "project", key: row.key },
    name: row.name,
    mode: readConsentMode(def.consent_mode),
    declaration: readConsentDeclaration(def.consent),
    caps: capsFromProjectDefinition(def),
    sharing: await sharingTargets(def),
    frontendOrigin: frontendOriginOf(def),
  };
}

export async function resolveProjectSubject(projectKey: string): Promise<ResolvedConsentSubject | null> {
  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, projectKey)).limit(1);
  if (!rows[0] || !rows[0].isActive) return null;
  return fromProjectRow(rows[0]);
}

/**
 * target (origin / redirect_uri) の origin と frontend_url の origin が一致する project key。
 * 複数一致したら key の昇順で先頭を選ぶ (決定的にする。同じ origin を共有する構成は想定外)。
 */
export function matchProjectByOrigin(
  projects: ReadonlyArray<{ key: string; frontendUrl: string | null }>,
  target: string,
): string | null {
  const origin = originOf(target);
  if (!origin) return null;
  const matches = projects.filter((p) => p.frontendUrl && originOf(p.frontendUrl) === origin)
    .map((p) => p.key).sort();
  return matches[0] ?? null;
}

export async function resolveSubjectByOrigin(target: string): Promise<ResolvedConsentSubject | null> {
  const rows = await db.select().from(schema.managedProjects).where(eq(schema.managedProjects.isActive, true));
  const candidates = rows.map((row) => {
    const url = definitionOf(row).endpoint?.frontend_url;
    return { key: row.key, frontendUrl: typeof url === "string" ? url : null };
  });
  const key = matchProjectByOrigin(candidates, target);
  if (!key) {
    devLog("consent.resolve.noProjectForOrigin", { origin: originOf(target) });
    return null;
  }
  return fromProjectRow(rows.find((row) => row.key === key)!);
}

export async function resolveOidcSubject(clientId: string): Promise<ResolvedConsentSubject | null> {
  const rows = await db.select().from(schema.oidcClients).where(eq(schema.oidcClients.clientId, clientId)).limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as unknown[]).filter((s): s is string => typeof s === "string") : [];
  return {
    subject: { kind: "oidc_client", key: row.clientId },
    name: row.name,
    mode: readConsentMode(row.consentMode),
    declaration: readConsentDeclaration(row.consent),
    caps: capsFromOidcScopes(scopes),
    sharing: [],
    frontendOrigin: null,
  };
}

export async function resolveConsentSubject(subject: ConsentSubject): Promise<ResolvedConsentSubject | null> {
  return subject.kind === "project" ? resolveProjectSubject(subject.key) : resolveOidcSubject(subject.key);
}
