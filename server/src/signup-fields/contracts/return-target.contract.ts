// C-30: only Cernere-internal paths resolve to a target; the target is the /composite/login origin or a
// redirect_uri query value, never the path itself.
const BACKSLASH_PATH = '/' + String.fromCharCode(92);

export default {
  post: (result: string | null, returnTo: unknown): true | string => {
    if (result === null) return true;
    if (typeof returnTo !== 'string' || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.startsWith(BACKSLASH_PATH)) {
      return 'a target was taken from a return path outside Cernere';
    }
    const params = new URL(returnTo, 'https://cernere.internal').searchParams;
    return result === params.get('origin') || result === params.get('redirect_uri') || 'the target is not the origin / redirect_uri parameter';
  },
};
