import { describe, expect, it } from 'vitest';
import { displayHost, readListenHosts } from '../../src/http/listen-host.js';

describe('LISTEN_HOST', () => {
  it('keeps all interfaces when unset or blank', () => {
    expect(readListenHosts({})).toBeNull();
    expect(readListenHosts({ LISTEN_HOST: '  ' })).toBeNull();
  });
  it('accepts loopback and address literals', () => {
    expect(readListenHosts({ LISTEN_HOST: '127.0.0.1' })).toEqual(['127.0.0.1']);
    expect(readListenHosts({ LISTEN_HOST: '::1' })).toEqual(['::1']);
    expect(readListenHosts({ LISTEN_HOST: 'localhost' })).toEqual(['localhost']);
    expect(readListenHosts({ LISTEN_HOST: '198.51.100.10' })).toEqual(['198.51.100.10']);
  });
  it('accepts several addresses and drops duplicates', () => {
    expect(readListenHosts({ LISTEN_HOST: '127.0.0.1, 198.51.100.20,127.0.0.1' }))
      .toEqual(['127.0.0.1', '198.51.100.20']);
  });
  it('rejects host names, ports, malformed addresses and empty entries', () => {
    for (const value of ['example.com', '127.0.0.1:8080', '256.0.0.1', 'http://127.0.0.1', '[::1]', '127.0.0.1,', '127.0.0.1,example.com']) {
      expect(() => readListenHosts({ LISTEN_HOST: value })).toThrow(/LISTEN_HOST/);
    }
  });
  it('formats the address for log lines', () => {
    expect(displayHost(null)).toBe('localhost');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('::1')).toBe('[::1]');
  });
});
