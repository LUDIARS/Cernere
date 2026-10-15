/**
 * 既存アカウントを連携に加える前の警告 (spec/plan/2026-10-15-account-federation-design.md §4.2)。
 *
 * C の番号で保存されたサービスのデータは連携の番号へ移らない (自動で混ぜない)。承認前に
 * 「C で使っていたサービス」を両側へ見せるため、C の番号で同意記録かプロジェクトの行があるサービスを並べる。
 */

import { eq, inArray } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { serviceSubjectId } from "./subject.js";

export interface ServiceUsage {
  kind: "project" | "oidc_client";
  key: string;
  name: string;
}

export async function listServiceUsage(userId: string): Promise<ServiceUsage[]> {
  const subject = await serviceSubjectId(userId);
  const consents = await db.select({ kind: schema.userServiceConsents.subjectKind, key: schema.userServiceConsents.subjectKey })
    .from(schema.userServiceConsents).where(eq(schema.userServiceConsents.userId, subject));
  const projectKeys = new Set(consents.filter((c) => c.kind === "project").map((c) => c.key));
  const clientIds = new Set(consents.filter((c) => c.kind === "oidc_client").map((c) => c.key));

  // 同意の無い (consent_mode off の) サービスも、プロジェクトの行があれば使っていたものとして出す。
  const { listUserProjectsOverview } = await import("../project/service.js");
  for (const project of await listUserProjectsOverview(subject)) {
    if (project.inUse) projectKeys.add(project.key);
  }

  const projects = projectKeys.size === 0 ? [] : await db.select({ key: schema.managedProjects.key, name: schema.managedProjects.name })
    .from(schema.managedProjects).where(inArray(schema.managedProjects.key, [...projectKeys]));
  const clients = clientIds.size === 0 ? [] : await db.select({ key: schema.oidcClients.clientId, name: schema.oidcClients.name })
    .from(schema.oidcClients).where(inArray(schema.oidcClients.clientId, [...clientIds]));
  return [
    ...projects.map((p) => ({ kind: "project" as const, key: p.key, name: p.name })),
    ...clients.map((c) => ({ kind: "oidc_client" as const, key: c.key, name: c.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
