import { describe, expect, it } from 'vitest';
import { displayHost, readListenHost } from '../../src/http/listen-host.js';

describe('LISTEN_HOST', () => {
  it('keeps all interfaces when unset or blank', () => {
    expect(readListenHost({})).toBeNull();
    expect(readListenHost({ LISTEN_HOST: '  ' })).toBeNull();
  });
  it('accepts loopback and address literals', () => {
    expect(readListenHost({ LISTEN_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(readListenHost({ LISTEN_HOST: '::1' })).toBe('::1');
    expect(readListenHost({ LISTEN_HOST: 'localhost' })).toBe('localhost');
    expect(readListenHost({ LISTEN_HOST: '100.122.174.105' })).toBe('100.122.174.105');
  });
  it('rejects host names, ports and malformed addresses', () => {
    for (const value of ['example.com', '127.0.0.1:8080', '256.0.0.1', 'http://127.0.0.1', '[::1]']) {
      expect(() => readListenHost({ LISTEN_HOST: value })).toThrow(/LISTEN_HOST/);
    }
  });
  it('formats the address for log lines', () => {
    expect(displayHost(null)).toBe('localhost');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('::1')).toBe('[::1]');
  });
});
