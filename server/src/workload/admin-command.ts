import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection.js';
import { workloadPrincipals, workloadKeys, workloadGrants, workloadTokens } from '../db/workload-schema.js';
import { hashProjectSecret } from '../project/credentials.js';
import { AppError } from '../error.js';
import { parseWorkloadGrant, parseWorkloadRegistration, workloadId } from './input.js';

/** Only called after dispatch's live user session and system-admin guards. */
export async function workloadAdminCommand(action: string, input: unknown): Promise<unknown> {
  try {
    switch (action) {
      case 'register': {
        const data = parseWorkloadRegistration(input);
        const clientId = randomUUID();
        const keyId = randomUUID();
        const clientSecret = randomBytes(32).toString('base64url');
        const clientSecretHash = await hashProjectSecret(clientSecret);
        await db.transaction(async tx => {
          await tx.insert(workloadPrincipals).values({ id: data.id, clientId, clientSecretHash });
          await tx.insert(workloadKeys).values({ id: keyId, subject: data.id, publicKeyPem: data.publicKeyPem });
        });
        return { id: data.id, key_id: keyId, client_id: clientId, client_secret: clientSecret };
      }
      case 'grant': {
        const data = parseWorkloadGrant(input);
        const id = randomUUID();
        await db.insert(workloadGrants).values({ ...data, id, keys: data.keys ?? null });
        return { id };
      }
      case 'revoke_principal':
      case 'revoke_key':
      case 'revoke_grant':
      case 'revoke_token': {
        const parsed = z.object({ id: action === 'revoke_principal' ? workloadId : z.string().uuid() }).strict().safeParse(input);
        if (!parsed.success) throw AppError.badRequest('Invalid revocation request');
        const table = action === 'revoke_principal' ? workloadPrincipals : action === 'revoke_key' ? workloadKeys
          : action === 'revoke_grant' ? workloadGrants : workloadTokens;
        await db.update(table).set({ revokedAt: sql`COALESCE(${table.revokedAt}, CURRENT_TIMESTAMP)` })
          .where(eq(table.id, parsed.data.id));
        return { revoked: true };
      }
      default: throw AppError.badRequest('Unknown workload management action');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Drizzle errors may contain parameter values. Never propagate them to WS/audit logs.
    throw AppError.serviceUnavailable('Workload management unavailable');
  }
}
