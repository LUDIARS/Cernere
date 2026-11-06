/** Basic login identity never implicitly discloses the account's email. @implements SPEC-COMPOSITE-OPERATION-GUARD */
export function serviceUserView(identity: { subject: string; displayName: string; email: string | null; role: string },
  permissions: readonly { key: string; allowed: boolean }[]): { id: string; displayName: string; email: string | null; role: string } {
  return { id: identity.subject, displayName: identity.displayName, role: identity.role,
    email: permissions.some(permission => permission.key === "identity_claim.email" && permission.allowed) ? identity.email : null };
}
