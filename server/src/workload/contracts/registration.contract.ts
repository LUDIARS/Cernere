export default {
  post: (result: { id: string; publicKeyPem: string }): true | string =>
    (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(result.id)
      && result.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
      && !result.publicKeyPem.includes('PRIVATE')) || 'invalid workload registration',
};
