import { describe, expect, it } from 'vitest';
import { readRedisDb } from '../src/redis-db.js';

describe('REDIS_DB', () => {
  it('keeps the REDIS_URL database when unset or blank', () => {
    expect(readRedisDb({})).toBeUndefined();
    expect(readRedisDb({ REDIS_DB: ' ' })).toBeUndefined();
  });
  it('accepts logical databases 0 to 15', () => {
    expect(readRedisDb({ REDIS_DB: '0' })).toBe(0);
    expect(readRedisDb({ REDIS_DB: '9' })).toBe(9);
    expect(readRedisDb({ REDIS_DB: '15' })).toBe(15);
  });
  it('rejects values outside the range or not integers', () => {
    for (const value of ['16', '-1', '1.5', 'abc', '100']) {
      expect(() => readRedisDb({ REDIS_DB: value })).toThrow(/REDIS_DB/);
    }
  });
});
