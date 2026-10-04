/**
 * project client credentials 由来の service token に、 宣言済み service_scopes の scope を要求する。
 *
 * Ostiarius は project_credentials ログインで得た project token を Bearer に載せて呼ぶ
 * (Ostiarius server/cernere-service-token.ts)。 project token 自体は scope を持たないので、
 * 呼出元 project の schema_definition.service_scopes (管理者所有) を毎回 DB から引いて判定する。
 * 宣言を外せば次の呼び出しから拒否される (token の失効を待たない)。
 *
 *   token なし / 不正 / rotate 済み → 401
 *   scope 未宣言                     → 403
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { extractBearerToken, verifyProjectToken } from "../auth/jwt.js";
import { AppError } from "../error.js";
import { isCurrentProjectCredential } from "../project/project-credential-state.js";
import { declaredServiceScopes } from "../project/service-scopes.js";

export interface ProjectServicePrincipal { projectKey: string; clientId: string }

export async function requireProjectServiceScope(authHeader: string, scope: string): Promise<ProjectServicePrincipal> {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");
  const claims = verifyProjectToken(token);
  if (!await isCurrentProjectCredential(claims.sub, claims.projectKey, claims.credentialGeneration ?? 0)) {
    throw AppError.unauthorized("Project credential is inactive or rotated");
  }
  const rows = await db.select({ schemaDefinition: managedProjects.schemaDefinition })
    .from(managedProjects).where(eq(managedProjects.clientId, claims.sub)).limit(1);
  if (!declaredServiceScopes(rows[0]?.schemaDefinition).includes(scope)) {
    throw AppError.forbidden(`Scope ${scope} is required`);
  }
  return { projectKey: claims.projectKey, clientId: claims.sub };
}
