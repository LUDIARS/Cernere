// C-2: derived scopes are well-formed, unique and sorted.
const SCOPE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export default {
  post: (result: readonly string[]): true | string => {
    if (!result.every((s) => SCOPE.test(s) && s.length <= 64)) return 'every derived scope must match <resource>:<action>';
    const sorted = [...new Set(result)].sort();
    return sorted.join(' ') === result.join(' ') || 'scopes must be deduplicated and sorted';
  },
};
