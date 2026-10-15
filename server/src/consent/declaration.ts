/**
 * 同意宣言の検証 — 形・語彙・管理者所有の上限・版の単調増加 (設計書 §3)。
 *
 * サービス (project client) は update_schema で `consent` を宣言できるが、上限の外の権限は
 * 保存させない (自己付与の禁止)。上限は profile_access / identity_claims / user_data の module /
 * oidc_clients.scopes。
 */

import { consentDeclarationSchema, type ConsentDeclaration } from "./declaration-schema.js";
import { IDENTITY_BASIC, isWithinCaps, parsePermissionKey, type ConsentCaps } from "./permission-keys.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:c850a93d */
import augurContract_b1c36ff7 from './contracts/declaration.contract.js'; /* augur-inject:contract-predicate:a55d265e */

export type DeclarationCheck =
  | { ok: true; declaration: ConsentDeclaration }
  | { ok: false; errors: string[] };

/** 版を上げずに権限の集合 (キーと必須/推奨) を変えたか。文言 (purpose) だけの変更は許す。 */
function permissionSetSignature(declaration: ConsentDeclaration): string {
  return declaration.permissions.map((p) => `${p.key}=${p.level}`).sort().join("|");
}

/**
 * 宣言を検証する。`previousVersion` / `previous` は保存済みの宣言 (無ければ null)。
 * 版を下げる更新と、版を据え置いたまま権限の集合を変える更新を拒否する
 * (後者を許すと再確認 (§5.2) が起きずに権限が増える)。
 * 契約 C-23 (server/src/consent/contracts/declaration.contract.ts) は augur inject が包む。
 */
export function validateConsentDeclaration(
  raw: unknown,
  caps: ConsentCaps,
  previousVersion: number | null,
  previous: ConsentDeclaration | null,
): DeclarationCheck {
  const parsed = consentDeclarationSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `consent.${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const declaration = parsed.data;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, permission] of declaration.permissions.entries()) {
    const where = `consent.permissions.${index}`;
    if (seen.has(permission.key)) errors.push(`${where}.key: duplicate permission ${permission.key}`);
    seen.add(permission.key);
    const key = parsePermissionKey(permission.key);
    if (!key) {
      errors.push(`${where}.key: unknown permission ${permission.key}`);
      continue;
    }
    if (!isWithinCaps(key, caps)) {
      errors.push(`${where}.key: ${permission.key} is outside the administrator grant`);
    }
    if (permission.key === IDENTITY_BASIC && permission.level !== "required") {
      errors.push(`${where}.level: ${IDENTITY_BASIC} is always required`);
    }
  }
  if (previousVersion !== null && declaration.version < previousVersion) {
    errors.push(`consent.version: must not go down (stored ${previousVersion}, got ${declaration.version})`);
  }
  if (previous && declaration.version === previous.version
    && permissionSetSignature(declaration) !== permissionSetSignature(previous)) {
    errors.push("consent.version: raise the version when permissions or levels change");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, declaration };
}
// @ts-expect-error augur-inject
validateConsentDeclaration = contract(validateConsentDeclaration, { ...augurContract_b1c36ff7, contractId: 'C-23', mode: 'observe', sample: 1, where: 'server/src/consent/declaration.ts:27', rule: 'contract-wrap', id: 'b1c36ff7' }); /* augur-inject:contract-wrap:b1c36ff7 */
