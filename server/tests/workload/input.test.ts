import { describe, expect, it } from 'vitest';
import { parseWorkloadRegistration, parseWorkloadGrant, issueInput } from '../../src/workload/input.js';
import { publicKeyPem, clientA } from './fixture.js';

describe('C-15 workload registration', () => {
  it('normalizes a public Ed25519 key', () => {
    expect(parseWorkloadRegistration({ id: 'site-a/excubitor', publicKeyPem })).toEqual({ id: 'site-a/excubitor', publicKeyPem });
  });
  it.each([
    { id: 'excubitor', publicKeyPem },
    { id: 'site-a/excubitor', publicKeyPem: publicKeyPem.replaceAll('PUBLIC', 'PRIVATE') },
    { id: 'site-a/excubitor', publicKeyPem: 'not-a-key' },
    { id: 'site-a/excubitor', publicKeyPem, grants: ['*'] },
    { id: 'site-a/excubitor', publicKeyPem, clientSecret: 'client-chosen' },
  ])('rejects invalid input without echoing it', input => {
    expect(() => parseWorkloadRegistration(input)).toThrow();
  });
});

describe('C-16 workload grants', () => {
  const base = { subject: 'site-a/excubitor', audience: 'site-b/excubitor', action: 'vault', resource: 'service:concordia' };
  it('preserves only exact admin keys, deduplicated', () => {
    expect(parseWorkloadGrant({ ...base, keys: ['KEY_B', 'KEY_A', 'KEY_A'] }).keys).toEqual(['KEY_A', 'KEY_B']);
  });
  it.each([
    base, { ...base, keys: [] }, { ...base, keys: ['*'] },
    { ...base, action: 'monitor', keys: ['KEY_A'] },
    { ...base, action: 'operation:spawn' },
    { ...base, action: 'hq-config', resource: 'service:other' },
    { ...base, action: 'monitor', resource: 'node:site-c/excubitor' },
    { ...base, action: 'ai-spawn', resource: 'thread:*:123' },
    { ...base, action: 'ai-inject', resource: 'thread:123:*' },
    { ...base, action: 'ai-spawn', resource: 'thread:123:456:789' },
    { ...base, action: 'ai-inject', resource: 'service:concordia' },
    { ...base, action: 'ai-spawn', resource: 'thread:123:456', keys: ['KEY_A'] },
  ])('rejects escalation/invalid resource', input => expect(() => parseWorkloadGrant(input)).toThrow());
  it.each([
    ['monitor', 'node:site-b/excubitor'], ['operation:restart', 'service:excubitor'],
    ['hq-config', 'service:concordia'], ['bundle', 'repository:LUDIARS/Cernere'],
    ['ai-spawn', 'thread:123:456'], ['ai-inject', 'thread:123:456'],
  ])('accepts %s on %s', (action, resource) => expect(parseWorkloadGrant({ ...base, action, resource }).action).toBe(action));
  it('client token requests cannot supply claims, keys, lifetime or grants', () => {
    const input = { client_id: clientA, client_secret: 's'.repeat(43), audience: base.audience, action: 'vault', resource: base.resource };
    for (const extra of [{ keys: ['OTHER'] }, { sub: 'other/workload' }, { grants: [] }, { exp: '2099' }, { cnf: {} }]) {
      expect(issueInput.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
});
