/**
 * project token (service-to-service Bearer) が「今も有効な資格情報か」を DB で確かめる。
 *
 * JWT の署名検証だけでは、無効化されたプロジェクトや rotate 済みの古い token を
 * 弾けない (期限切れまで通ってしまう)。WebSocket の upgrade と REST export の
 * 双方から同じ判定を使うため、ws / http のどちらにも属さないこの層に置く。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

export async function isCurrentProjectCredential(
  clientId: string,
  projectKey: string,
  credentialGeneration: number,
): Promise<boolean> {
  const rows = await db.select({
    key: schema.managedProjects.key,
    clientId: schema.managedProjects.clientId,
    isActive: schema.managedProjects.isActive,
    credentialGeneration: schema.managedProjects.credentialGeneration,
  })
    .from(schema.managedProjects)
    .where(eq(schema.managedProjects.clientId, clientId))
    .limit(1);
  const project = rows[0];
  return Boolean(
    project?.isActive
    && project.clientId === clientId
    && project.key === projectKey
    && project.credentialGeneration === credentialGeneration,
  );
}
