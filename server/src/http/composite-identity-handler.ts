/** Narrow Cr-owned identity operations for a currently bound service session.
 * No arbitrary user, module, endpoint or biometric-data operation is accepted.
 * @implements SPEC-COMPOSITE-SCOPED-IDENTITY
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../error.js';
import { db } from '../db/connection.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { currentCompositeSession } from '../auth/composite-session.js';
import { requireCompositeOperation } from '../auth/composite-operation-permission.js';
import { createFaceConsent, listOwnFaceConsents, revokeFaceConsents } from '../identity/face-consent-store.js';
import { recordFaceAudit } from '../logging/face-audit.js';

const inputSchema = z.object({ projectToken: z.string().min(1).max(16_384), sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  requestId: z.string().uuid(), permit: z.string().regex(/^[A-Za-z0-9_-]{43}$/), payload: z.string().max(4096) }).strict();
const empty = z.object({}).strict();
const create = z.object({ facilityId: z.string().uuid(), policyVersion: z.string().trim().min(1).max(128) }).strict();
const revoke = z.object({ facilityId: z.string().uuid().optional() }).strict();
const contracts = {
  'identity-organizations': { action: 'identity.organizations.read', resource: 'self:organizations', risk: 'sensitive_read', schema: empty },
  'identity-face-consent-status': { action: 'identity.face-consent.read', resource: 'self:face-consent', risk: 'sensitive_read', schema: empty },
  'identity-face-consent-create': { action: 'identity.face-consent.create', resource: 'self:face-consent', risk: 'important', schema: create },
  'identity-face-consent-revoke': { action: 'identity.face-consent.revoke', resource: 'self:face-consent', risk: 'important', schema: revoke },
} as const;

export async function handleCompositeIdentityRoute(route: string, raw: unknown, authHeader: string): Promise<{ status: string; data: unknown }> {
  if (!Object.hasOwn(contracts, route)) throw AppError.notFound('Unknown scoped identity operation');
  const contract = contracts[route as keyof typeof contracts];
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest('Invalid scoped identity request');
  const input = parsed.data;
  let payload: unknown;
  try { payload = JSON.parse(input.payload); } catch { throw AppError.badRequest('Invalid identity payload'); }
  if (!contract.schema.safeParse(payload).success) throw AppError.badRequest('Invalid identity payload');
  const context = await currentCompositeSession(input, authHeader);
  // Even a nominally read policy cannot downgrade these protected Cr resources.
  const policy = requireCompositeOperation(context, contract.action, true);
  if (policy.risk !== contract.risk) throw AppError.forbidden('Scoped identity risk is not correctly configured');
  // Reuse the ordinary authoritative consume path: it rechecks current session,
  // project/user/consent/permissions and atomically consumes this exact operation.
  const { handleCompositeServiceRoute } = await import('./composite-service-handler.js');
  await handleCompositeServiceRoute('consume', JSON.stringify({ projectToken: input.projectToken, sessionBinding: input.sessionBinding,
    requestId: input.requestId, permit: input.permit, action: contract.action, resource: contract.resource,
    contentDigest: createHash('sha256').update(input.payload, 'utf8').digest('base64url') }), authHeader);
  // Cr organization/consent rows use the native account, never a caller-provided
  // service subject or arbitrary userId. Existing mutation membership/locking
  // checks remain in createFaceConsent/revokeFaceConsents.
  const userId = context.grant.source.sub;
  let data: unknown;
  if (route === 'identity-organizations') {
    const items = await db.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
      .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId)).limit(1001);
    if (items.length > 1000) throw AppError.withCode(503, 'identity_result_capacity', 'Organization membership capacity exceeded');
    data = { items };
  } else if (route === 'identity-face-consent-status') {
    data = await listOwnFaceConsents(userId);
  } else if (route === 'identity-face-consent-create') {
    const value = create.parse(payload);
    data = { ...await createFaceConsent(userId, value.policyVersion, value.facilityId), facilityId: value.facilityId, policyVersion: value.policyVersion };
    await recordFaceAudit({ action: 'identity.face_consent.create', actorUserId: userId, targetUserId: userId,
      facilityId: value.facilityId, reason: value.policyVersion });
  } else {
    const value = revoke.parse(payload);
    data = await revokeFaceConsents(userId, value.facilityId, 'withdrawn');
    await recordFaceAudit({ action: 'identity.face_consent.revoke', actorUserId: userId, targetUserId: userId,
      ...(value.facilityId ? { facilityId: value.facilityId } : {}), reason: 'withdrawn' });
  }
  return { status: '200 OK', data: { requestId: input.requestId, risk: contract.risk, data } };
}
