/**
 * schema_definition の管理者所有フィールド。
 *
 * project client が update_schema で自己申告しても保存しない。 自己付与を許すと、
 * project が users の identity 列を開示対象にしたり (identity_claims)、 service token の
 * scope を広げたり (service_scopes)、 現地確認 MFA を外したり (onsite_mfa) できてしまう。
 */

export const ADMIN_OWNED_SCHEMA_FIELDS = [
  "data_sharing", "identity_claims", "service_scopes", "profile_access", "onsite_mfa",
] as const;
export type AdminOwnedSchemaField = (typeof ADMIN_OWNED_SCHEMA_FIELDS)[number];

export interface SplitSchemaPayload {
  /** 保存対象にしてよい project 所有部分 (管理者所有フィールドを除いた浅いコピー)。 */
  projectOwned: Record<string, unknown>;
  /** 送られてきたが保存しなかった管理者所有フィールド名。 */
  submittedAdminOwned: AdminOwnedSchemaField[];
}

export function splitAdminOwnedSchemaFields(payload: Record<string, unknown>): SplitSchemaPayload {
  const projectOwned = { ...payload };
  const submittedAdminOwned: AdminOwnedSchemaField[] = [];
  for (const field of ADMIN_OWNED_SCHEMA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) submittedAdminOwned.push(field);
    delete projectOwned[field];
  }
  return { projectOwned, submittedAdminOwned };
}
