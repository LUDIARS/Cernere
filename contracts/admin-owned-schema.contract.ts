// C-12: a project client's update_schema payload never keeps an administrator-owned field.
const ADMIN_OWNED = ['data_sharing', 'identity_claims', 'service_scopes', 'profile_access', 'onsite_mfa'];

export default {
  post: (result: { readonly projectOwned: Record<string, unknown> }): true | string => {
    const kept = ADMIN_OWNED.filter((field) => Object.prototype.hasOwnProperty.call(result.projectOwned, field));
    return kept.length === 0 || `administrator-owned fields were kept: ${kept.join(', ')}`;
  },
};
