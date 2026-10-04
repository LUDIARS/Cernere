/**
 * project 束縛ログインで要求する現地確認 MFA を managed_projects から引く (C2)。
 * 判定は schema_definition.onsite_mfa (管理者所有) だけで決まる。
 * @implements SPEC-MFA-ONSITE
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { AppError } from "../error.js";
import { onsiteRequirementOf, type OnsiteRequirement } from "./onsite-mfa.js";

/** projectKey 無し (Cernere 直のログイン) は要求なし。 不明な project は要求を外さず拒否する。 */
export async function projectOnsiteRequirement(projectKey: string | undefined): Promise<OnsiteRequirement | null> {
  if (!projectKey) return null;
  const rows = await db.select({ schemaDefinition: managedProjects.schemaDefinition, isActive: managedProjects.isActive })
    .from(managedProjects).where(eq(managedProjects.key, projectKey)).limit(1);
  const project = rows[0];
  if (!project || !project.isActive) throw AppError.forbidden("Project is not active");
  try {
    return onsiteRequirementOf(project.schemaDefinition);
  } catch {
    // A broken declaration must not silently drop onsite verification (fail closed).
    throw AppError.serviceUnavailable("Onsite verification is misconfigured for this service");
  }
}
