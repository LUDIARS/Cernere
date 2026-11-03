import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyQsLock } from './verify-qs-lock.mjs';

const lock = () => JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('body-parser uses the patch while Express retains its supported minor', () => {
  assert.equal(verifyQsLock(lock()), true);
});

test('rejects the old vulnerable body-parser lock', () => {
  const input = lock();
  input.packages['node_modules/body-parser/node_modules/qs'].version = '6.16.0';
  assert.throws(() => verifyQsLock(input), /approved range-limited update/);
});

test('rejects moving Express outside its unchanged qs range', () => {
  const input = lock();
  input.packages['node_modules/qs'].version = '6.16.2';
  assert.throws(() => verifyQsLock(input), /approved range-limited update/);
});
