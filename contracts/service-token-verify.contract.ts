// C-3: an accepted token is a service token addressed to the verifier.
type Claims = { readonly kind: string; readonly aud: string; readonly scope: readonly unknown[] };

export default {
  post: (result: Claims, _token: string, expectedAudience: string): true | string => {
    if (result.kind !== 'service') return 'only kind=service tokens may be accepted';
    if (result.aud !== expectedAudience) return 'aud must equal the verifier audience';
    return result.scope.every((s) => typeof s === 'string') || 'scope must be a string array';
  },
};
