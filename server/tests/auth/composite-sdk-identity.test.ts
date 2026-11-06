import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CompositeServiceIdentity } from '../../../packages/composite/src/service-identity.js';
import type { BoundServiceSession } from '../../../packages/composite/src/service-session.js';
const session: BoundServiceSession = { projectToken: 'private-scoped-token', sessionBinding: 's'.repeat(43), projectKey: 'glab',
  expiresAt: new Date(Date.now() + 600_000).toISOString(), user: { id: 'service-subject', role: 'general', displayName: 'Person', email: null } };
const owned = { grant: session, isCurrent: () => true };

describe('scoped identity SDK', () => {
  it('prepares the ordinary one-use permit and lets the data endpoint consume it', async () => {
    let requestId: string | undefined;
    const call = vi.fn(async (action: string, body: unknown) => {
      const request = body as { requestId: string };
      if (action === 'authorize') { requestId = request.requestId; return { permit: 'p'.repeat(43), expiresIn: 30, risk: 'sensitive_read' }; }
      return { requestId, risk: 'sensitive_read', data: { items: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Own organization', role: 'owner' }] } };
    });
    expect(await new CompositeServiceIdentity(call).organizations(owned)).toHaveLength(1);
    expect(call).toHaveBeenNthCalledWith(1, 'authorize', expect.objectContaining({ action: 'identity.organizations.read', resource: 'self:organizations',
      contentDigest: createHash('sha256').update('{}').digest('base64url') }));
    expect(call).toHaveBeenNthCalledWith(2, 'identity-organizations', expect.objectContaining({ payload: '{}', requestId, permit: 'p'.repeat(43),
      projectToken: session.projectToken, sessionBinding: session.sessionBinding }));
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('refuses a downgraded read risk before invoking the data endpoint', async () => {
    const call = vi.fn().mockResolvedValue({ permit: 'p'.repeat(43), expiresIn: 30, risk: 'read' });
    await expect(new CompositeServiceIdentity(call).organizations(owned)).rejects.toThrow();
    expect(call).toHaveBeenCalledOnce();
  });
  it('does not retry an unknown data result or return a replacement credential', async () => {
    const call = vi.fn().mockResolvedValueOnce({ permit: 'p'.repeat(43), expiresIn: 30, risk: 'sensitive_read' }).mockRejectedValueOnce(new Error('Unknown result'));
    await expect(new CompositeServiceIdentity(call).organizations(owned)).rejects.toThrow('Unknown result');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('validates explicit facility input before requesting permission', async () => {
    const call = vi.fn(); const identity = new CompositeServiceIdentity(call);
    await expect(identity.createFaceConsent(owned, 'foreign-facility', 'policy')).rejects.toThrow();
    await expect(identity.revokeFaceConsent(owned, 'foreign-facility')).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it('does not invoke the data endpoint after logout during permit preparation', async () => {
    let current = true;
    let resolvePermit: ((value: unknown) => void) | undefined;
    const call = vi.fn(() => new Promise<unknown>(resolve => { resolvePermit = resolve; }));
    const pending = new CompositeServiceIdentity(call).organizations({ grant: session, isCurrent: () => current });
    current = false;
    resolvePermit?.({ permit: 'p'.repeat(43), expiresIn: 30, risk: 'sensitive_read' });
    await expect(pending).rejects.toThrow('owner ended');
    expect(call).toHaveBeenCalledOnce();
  });
});
