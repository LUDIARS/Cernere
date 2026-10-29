import { describe, expect, it } from 'vitest';
import { normalizeIp, readTrustedProxies, resolveClientIp } from '../../src/http/client-ip.js';

describe('client IP', () => {
  const trusted = readTrustedProxies({ CERNERE_TRUSTED_PROXIES: '127.0.0.1, ::1' });

  it('uses CF-Connecting-IP only behind a trusted proxy', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.7', trusted)).toBe('203.0.113.7');
    expect(resolveClientIp('::ffff:127.0.0.1', '2001:db8::1', trusted)).toBe('2001:db8::1');
  });

  it('ignores the header from untrusted peers', () => {
    expect(resolveClientIp('198.51.100.20', '203.0.113.7', trusted)).toBe('198.51.100.20');
    expect(resolveClientIp('127.0.0.1', '203.0.113.7', new Set())).toBe('127.0.0.1');
  });

  it('falls back to the peer when the header is missing or not an IP', () => {
    expect(resolveClientIp('127.0.0.1', undefined, trusted)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', '203.0.113.7, 198.51.100.1', trusted)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', 'evil', trusted)).toBe('127.0.0.1');
  });

  it('normalizes mapped IPv4 and rejects non-addresses', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('')).toBeUndefined();
    expect(normalizeIp('example.com')).toBeUndefined();
  });

  it('rejects malformed trusted proxy lists', () => {
    expect(readTrustedProxies({}).size).toBe(0);
    expect(() => readTrustedProxies({ CERNERE_TRUSTED_PROXIES: '127.0.0.1,localhost' })).toThrow(/CERNERE_TRUSTED_PROXIES/);
    expect(() => readTrustedProxies({ CERNERE_TRUSTED_PROXIES: '127.0.0.1,' })).toThrow(/CERNERE_TRUSTED_PROXIES/);
  });
});
