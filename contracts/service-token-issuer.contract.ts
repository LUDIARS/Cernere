// C-1: claims come only from registration data; an empty declaration never yields a token.
type Issued = { readonly scope: readonly string[]; readonly subject: string; readonly audience: string };

export default {
  post: (result: Issued): true | string => {
    if (result.scope.length === 0) return 'a service token must not be issued without declared scopes';
    if (!result.subject || !result.audience) return 'sub and aud must be resolved from storage_slug';
    const sorted = [...new Set(result.scope)].sort();
    return sorted.join(' ') === result.scope.join(' ') || 'scope must be deduplicated and sorted';
  },
};
