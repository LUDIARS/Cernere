// The predicate checks the lock input independently of the verifier's result.
export default {
  post: (result, lock) => {
    const packages = lock.packages;
    const patched = packages['node_modules/body-parser/node_modules/qs'];
    return result === true
      && packages['node_modules/body-parser'].version === '1.20.8'
      && packages['node_modules/body-parser'].dependencies.qs === '~6.16.0'
      && patched.version === '6.16.2'
      && patched.resolved === 'https://registry.npmjs.org/qs/-/qs-6.16.2.tgz'
      && patched.integrity === 'sha512-VYdnB5S7/0IeXzBacUtwNAaM6d7Y/PgYnNC7bJCI6meqA/OgnsQbZMtVW8Dt2D1PHgbHGtYmhSoEIgvt7xZ2ZA=='
      && packages['node_modules/express'].version === '4.22.2'
      && packages['node_modules/express'].dependencies.qs === '~6.15.1'
      && packages['node_modules/qs'].version === '6.15.3'
      || 'qs lock must respect both unchanged parent ranges and registry metadata';
  },
};
