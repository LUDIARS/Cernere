import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contract } from './ontime-runtime.mjs'; /* augur-inject:import:b25550cf */
import augurContract_aa99fac6 from './qs-lock.contract.mjs'; /* augur-inject:contract-predicate:4ad46554 */

/** Offline check for the dependency decision recorded in Actio 8eeb12ec. */
export function verifyQsLock(lock) {
  const packages = lock.packages;
  const patched = packages['node_modules/body-parser/node_modules/qs'];
  if (packages['node_modules/body-parser'].version !== '1.20.8'
    || packages['node_modules/body-parser'].dependencies.qs !== '~6.16.0'
    || patched.version !== '6.16.2'
    || patched.resolved !== 'https://registry.npmjs.org/qs/-/qs-6.16.2.tgz'
    || patched.integrity !== 'sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA=='
    || packages['node_modules/express'].version !== '4.22.2'
    || packages['node_modules/express'].dependencies.qs !== '~6.15.1'
    || packages['node_modules/qs'].version !== '6.15.3') {
    throw new Error('qs lock differs from the approved range-limited update');
  }
  return true;
}
// @ts-expect-error augur-inject
verifyQsLock = contract(verifyQsLock, { ...augurContract_aa99fac6, contractId: 'C-1', mode: 'observe', sample: 1, where: 'scripts/verify-qs-lock.mjs:5', rule: 'contract-wrap', id: 'aa99fac6' }); /* augur-inject:contract-wrap:aa99fac6 */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyQsLock(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
}
