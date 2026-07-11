import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import { decryptSecret, encryptSecret } from "../lib/crypto/secret-box.js";
import { hashProjectSecret } from "./credentials.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProjectLaunchCredential {
  targetProjectKey: string;
  launchId: string;
  clientId: string;
  adminUserIds: string[];
  issuedAt: string;
  idempotent: boolean;
}

/** 平文・認証用hash・DB保存用暗号文を同時に生成する。 */
export async function createLaunchCredentialMaterial(clientSecret: string): Promise<{
  clientSecretHash: string;
  clientSecretEncrypted: string;
}> {
  const clientSecretHash = await hashProjectSecret(clientSecret);
  return {
    clientSecretHash,
    clientSecretEncrypted: encryptSecret(clientSecret),
  };
}

/**
 * launcher project の許可を検査し、target project のcredentialを起動単位でrotateする。
 * 同じlaunchIdの再送は、まだactiveなら暗号化履歴を復号して同じ値を返す。
 */
export async function issueProjectLaunchCredential(
  issuerProjectKey: string,
  targetProjectKey: string,
  launchId: string,
  clientSecret: string,
): Promise<ProjectLaunchCredential> {
  if (!UUID_RE.test(launchId)) throw AppError.badRequest("launch_id must be a UUID");
  if (!targetProjectKey.trim()) throw AppError.badRequest("target_project_key is required");
  if (clientSecret.length < 32) {
    throw AppError.badRequest("target_client_secret must be at least 32 characters");
  }

  const adminRows = await db.select({ id: dbSchema.users.id }).from(dbSchema.users)
    .where(eq(dbSchema.users.role, "admin"));
  if (adminRows.length === 0) {
    throw AppError.badRequest("Cernere has no admin user for the launched service");
  }

  const issued = await db.transaction(async (tx) => {
    // target単位にserializeし、同時launchでcurrent hashとactive履歴がねじれないようにする。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`project-launch:${targetProjectKey}`}))`);

    const grants = await tx.select({ active: dbSchema.projectCredentialIssuers.isActive })
      .from(dbSchema.projectCredentialIssuers)
      .where(and(
        eq(dbSchema.projectCredentialIssuers.targetProjectKey, targetProjectKey),
        eq(dbSchema.projectCredentialIssuers.issuerProjectKey, issuerProjectKey),
      )).limit(1);
    if (grants.length === 0 || !grants[0].active) {
      throw AppError.forbidden(
        `Project "${issuerProjectKey}" may not issue credentials for "${targetProjectKey}"`,
      );
    }

    const targets = await tx.select({
      key: dbSchema.managedProjects.key,
      clientId: dbSchema.managedProjects.clientId,
      active: dbSchema.managedProjects.isActive,
    }).from(dbSchema.managedProjects)
      .where(eq(dbSchema.managedProjects.key, targetProjectKey)).limit(1);
    if (targets.length === 0 || !targets[0].active) throw AppError.notFound("Target project not found");

    const previous = await tx.select({
      clientId: dbSchema.projectLaunchCredentials.clientId,
      encrypted: dbSchema.projectLaunchCredentials.clientSecretEncrypted,
      issuedAt: dbSchema.projectLaunchCredentials.issuedAt,
      revokedAt: dbSchema.projectLaunchCredentials.revokedAt,
    }).from(dbSchema.projectLaunchCredentials)
      .where(and(
        eq(dbSchema.projectLaunchCredentials.issuerProjectKey, issuerProjectKey),
        eq(dbSchema.projectLaunchCredentials.targetProjectKey, targetProjectKey),
        eq(dbSchema.projectLaunchCredentials.launchId, launchId),
      )).limit(1);
    if (previous.length > 0) {
      if (previous[0].revokedAt) {
        throw AppError.conflict("launch credential has already been superseded");
      }
      if (decryptSecret(previous[0].encrypted) !== clientSecret) {
        throw AppError.conflict("launch_id was already used with a different credential");
      }
      return {
        clientId: previous[0].clientId,
        issuedAt: previous[0].issuedAt,
        idempotent: true,
      };
    }

    const material = await createLaunchCredentialMaterial(clientSecret);
    const now = new Date();
    await tx.update(dbSchema.projectLaunchCredentials).set({ revokedAt: now })
      .where(and(
        eq(dbSchema.projectLaunchCredentials.targetProjectKey, targetProjectKey),
        isNull(dbSchema.projectLaunchCredentials.revokedAt),
      ));
    await tx.update(dbSchema.managedProjects).set({
      clientSecretHash: material.clientSecretHash,
      updatedAt: now,
    }).where(eq(dbSchema.managedProjects.key, targetProjectKey));
    await tx.insert(dbSchema.projectLaunchCredentials).values({
      id: crypto.randomUUID(),
      targetProjectKey,
      issuerProjectKey,
      launchId,
      clientId: targets[0].clientId,
      clientSecretEncrypted: material.clientSecretEncrypted,
      issuedAt: now,
    });

    return {
      clientId: targets[0].clientId,
      issuedAt: now,
      idempotent: false,
    };
  });

  return {
    targetProjectKey,
    launchId,
    clientId: issued.clientId,
    adminUserIds: adminRows.map((row) => row.id),
    issuedAt: issued.issuedAt.toISOString(),
    idempotent: issued.idempotent,
  };
}
