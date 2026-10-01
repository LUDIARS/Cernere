/**
 * service token の発行 (POST /api/auth/service-token)。
 *
 * 呼出元が渡すのは自分の client credentials と呼出先 project key だけ。
 * sub / aud / scope は request body から受け取らず、 managed_projects の登録情報から解決する:
 *   - sub   = 認証済み呼出元の storage_slug (不変)
 *   - aud   = 呼出先 project の storage_slug (不変)
 *   - scope = 呼出元の service_scopes 宣言 (管理者所有)
 * 宣言が空なら fail-closed で拒否する (空 scope の token を黙って出すと設定不備が見えない)。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { isPasetoEnabled } from "../auth/paseto.js";
import { SERVICE_TOKEN_TTL_SEC, signServiceToken } from "../auth/service-token.js";
import { verifyProjectSecret } from "./credentials.js";
import { declaredServiceScopes } from "./service-scopes.js";

export interface ServiceTokenRequest {
  clientId: string;
  clientSecret: string;
  targetProjectKey: string;
}

export interface IssuedServiceToken {
  tokenType: "service";
  accessToken: string;
  expiresIn: number;
  subject: string;
  audience: string;
  scope: string[];
  alg: "EdDSA";
  /** ログ用。 token には入れない (受け側に名前で分岐させないため)。 */
  callerProjectKey: string;
}

async function findProjectByClientId(clientId: string) {
  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.clientId, clientId)).limit(1);
  return rows[0];
}

async function findProjectByKey(key: string) {
  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, key)).limit(1);
  return rows[0];
}

export async function issueServiceToken(request: ServiceTokenRequest): Promise<IssuedServiceToken> {
  const caller = await findProjectByClientId(request.clientId);
  // 不在・無効・secret 不一致は同じ応答にして client_id の存在を漏らさない。
  if (!caller || !caller.isActive || !await verifyProjectSecret(request.clientSecret, caller.clientSecretHash)) {
    throw AppError.unauthorized("Invalid project credentials");
  }

  const target = await findProjectByKey(request.targetProjectKey);
  if (!target || !target.isActive) {
    throw AppError.notFound(`Target project '${request.targetProjectKey}' not found or inactive`);
  }

  const scopes = declaredServiceScopes(caller.schemaDefinition);
  if (scopes.length === 0) {
    throw AppError.forbidden(`Project '${caller.key}' declares no service_scopes`);
  }

  // 設定不備を暗黙降格させない (RULE §7.1)。 サーバ構成エラーなので 503。
  if (!isPasetoEnabled()) {
    throw AppError.serviceUnavailable("service-token signing unavailable: PASETO keys not configured");
  }

  const accessToken = await signServiceToken({
    subject: caller.storageSlug,
    audience: target.storageSlug,
    scopes,
  });
  return {
    tokenType: "service",
    accessToken,
    expiresIn: SERVICE_TOKEN_TTL_SEC,
    subject: caller.storageSlug,
    audience: target.storageSlug,
    scope: scopes,
    alg: "EdDSA",
    callerProjectKey: caller.key,
  };
}
