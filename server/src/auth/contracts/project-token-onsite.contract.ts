/** Keep the runtime predicate inside the server compilation root. */
type Input = { requirement: unknown; mfaToken?: string };
type Challenge = { mfaRequired: true; mfaToken: string; mfaMethods: string[] } | null;

export default {
  post(result: Challenge, input: Input): true | string {
    if (!input.requirement) return result === null || 'no requirement must preserve issuance';
    if (!input.mfaToken) {
      return (result?.mfaRequired === true && result.mfaToken.startsWith('mfa_')
        && result.mfaMethods.length === 1 && result.mfaMethods[0] === 'onsite')
        || 'missing proof must return only an onsite challenge';
    }
    return result === null || 'verified proof must complete the gate';
  },
};
