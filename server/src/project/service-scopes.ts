/**
 * service_scopes 宣言 (auth-plane consolidation P3)。
 *
 * 「どの service が何を呼べるか」を呼出元の名前で判定せず、
 * managed_projects.schema_definition.service_scopes (管理者所有) の宣言だけで決める。
 * identity_claims と同じく project client の update_schema では保存されない。
 *
 * Cernere 自身の face 系 scope (http/face-identity-auth.ts の定数) も同じ語彙で
 * 宣言でき、 宣言した project の service token に載る。
 */

import { serviceScopeSchema } from "./schema.js";

/**
 * 保存済み定義から service token に載せる scope を導出する。
 * 形式に合わない値は落とし (定義側の誤りで権限が広がらないように)、 重複を除いて昇順にする。
 */
export function declaredServiceScopes(definition: unknown): string[] {
  const declared = definition && typeof definition === "object"
    ? (definition as { service_scopes?: unknown }).service_scopes
    : undefined;
  if (!Array.isArray(declared)) return [];
  const valid = declared.filter((s): s is string => serviceScopeSchema.safeParse(s).success);
  return [...new Set(valid)].sort();
}
