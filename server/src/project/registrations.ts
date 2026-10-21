import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection.js';
import { managedProjects } from '../db/schema.js';
import { AppError } from '../error.js';
import { storageTableFromRow } from './storage-resolver.js';

/** Read the durable registration rows written by Cr's signup/consent hooks.
 * No profile values or other projects are exposed. Consumers must rescan from
 * the beginning after each completed pass to include concurrent registrations.
 * @implements SPEC-PROJECT-REGISTRATIONS-001
 */
export async function listProjectRegistrations(projectKey: string, payload: Record<string, unknown>) {
  const parsed = z.object({ after: z.string().uuid().optional() }).strict().safeParse(payload);
  if (!parsed.success) throw AppError.badRequest('Invalid registration cursor');
  const project = (await db.select({ storageSlug: managedProjects.storageSlug }).from(managedProjects)
    .where(and(eq(managedProjects.key, projectKey), eq(managedProjects.isActive, true))).limit(1))[0];
  if (!project) throw AppError.notFound('Project not found');
  const after = parsed.data.after;
  const rows = await db.execute(sql`SELECT user_id AS "userId", created_at AS "createdAt"
    FROM ${sql.identifier(storageTableFromRow(project))}
    ${after ? sql`WHERE user_id > ${after}::uuid` : sql``}
    ORDER BY user_id LIMIT 101`);
  const registrations = [...rows].slice(0, 100) as { userId: string; createdAt: Date | string }[];
  return { registrations, next: rows.length > 100 ? registrations.at(-1)?.userId ?? null : null };
}
