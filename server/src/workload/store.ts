import { and, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/connection.js';
import { workloadPrincipals, workloadKeys, workloadGrants, workloadTokens } from '../db/workload-schema.js';
import type { WorkloadStore } from './types.js';

const target = alias(workloadPrincipals, 'workload_target');
const targetKey = alias(workloadKeys, 'workload_target_key');

/** One SQL statement per authorization snapshot; never cache a revocation decision. */
export const workloadStore: WorkloadStore = {
  async principal(clientId) {
    const rows = await db.select().from(workloadPrincipals).where(eq(workloadPrincipals.clientId, clientId)).limit(1);
    return rows[0] ?? null;
  },
  async authority(subject, audience, action, resource) {
    const rows = await db.select({ subject: workloadPrincipals, target, key: workloadKeys, targetKey, grant: workloadGrants })
      .from(workloadGrants)
      .innerJoin(workloadPrincipals, eq(workloadPrincipals.id, workloadGrants.subject))
      .innerJoin(target, eq(target.id, workloadGrants.audience))
      .innerJoin(workloadKeys, eq(workloadKeys.subject, workloadPrincipals.id))
      .innerJoin(targetKey, eq(targetKey.subject, target.id))
      .where(and(eq(workloadGrants.subject, subject), eq(workloadGrants.audience, audience),
        eq(workloadGrants.action, action), eq(workloadGrants.resource, resource), isNull(workloadGrants.revokedAt))).limit(1);
    return rows[0] ?? null;
  },
  async saveToken(token) { await db.insert(workloadTokens).values(token); },
  async snapshot(tokenHash) {
    const rows = await db.select({ subject: workloadPrincipals, target, key: workloadKeys, targetKey,
      grant: workloadGrants, token: workloadTokens })
      .from(workloadTokens)
      .innerJoin(workloadPrincipals, eq(workloadPrincipals.id, workloadTokens.subject))
      .innerJoin(target, eq(target.id, workloadTokens.audience))
      .innerJoin(workloadKeys, eq(workloadKeys.id, workloadTokens.keyId))
      .innerJoin(targetKey, eq(targetKey.subject, target.id))
      .innerJoin(workloadGrants, eq(workloadGrants.id, workloadTokens.grantId))
      .where(eq(workloadTokens.tokenHash, tokenHash)).limit(1);
    return rows[0] ?? null;
  },
};
