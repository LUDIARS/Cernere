// C-11: an onsite requirement exists only for required=true and carries a valid minimum assurance.
type Requirement = { readonly minAssurance: string; readonly allowedPlaceIds: readonly string[] | null } | null;

export default {
  post: (result: Requirement, definition: unknown): true | string => {
    const declared = definition && typeof definition === 'object'
      ? (definition as { onsite_mfa?: { required?: unknown } }).onsite_mfa : undefined;
    if (declared?.required !== true) return result === null || 'only required=true may yield a requirement';
    if (result === null) return true; // malformed declarations fail closed at the caller
    return result.minAssurance === 'high' || result.minAssurance === 'medium' || 'min_assurance must be high or medium';
  },
};
