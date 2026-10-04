/**
 * サービス設定からの現地確認 MFA の要求 (Ostiarius spec onsite-mfa-factor.md §5 / C2)。
 *
 * managed_projects.schema_definition.onsite_mfa は service_scopes / identity_claims と同じ
 * **管理者所有フィールド**で、project client の update_schema では保存されない
 * (project/admin-owned-fields.ts)。required=true の project へのログインでは、
 * 利用者の MFA 設定有無にかかわらず onsite challenge を出す。
 * @implements SPEC-MFA-ONSITE
 */

import { z } from "zod";

export const ONSITE_MIN_ASSURANCES = ["high", "medium"] as const;
export type OnsiteMinAssurance = (typeof ONSITE_MIN_ASSURANCES)[number];

/** placeId は Ostiarius / Aedilis の施設識別子。形式は向こうが決めるので長さと文字種だけ縛る。 */
export const placeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "invalid placeId");

export const onsiteMfaDefinitionSchema = z.object({
  required: z.boolean(),
  min_assurance: z.enum(ONSITE_MIN_ASSURANCES),
  /** 未指定 = 全 active kiosk。空配列は「どこでも不可」になるので許さない。 */
  allowed_place_ids: z.array(placeIdSchema).min(1).optional(),
}).strict();
export type OnsiteMfaDefinition = z.infer<typeof onsiteMfaDefinitionSchema>;

/** challenge (MFA ticket) に載せる要求。 allowedPlaceIds=null は全 active kiosk。 */
export interface OnsiteRequirement {
  minAssurance: OnsiteMinAssurance;
  allowedPlaceIds: string[] | null;
}

/**
 * 保存済み定義から onsite 要求を導出する。 required=true 以外は null。
 * required=true なのに形式が壊れている定義は、要求を黙って外すと現地確認を素通しに
 * なるので例外にする (fail closed、RULE §7.1)。
 */
export function onsiteRequirementOf(definition: unknown): OnsiteRequirement | null {
  const declared = definition && typeof definition === "object"
    ? (definition as { onsite_mfa?: unknown }).onsite_mfa
    : undefined;
  if (!declared || typeof declared !== "object" || (declared as { required?: unknown }).required !== true) return null;
  const parsed = onsiteMfaDefinitionSchema.safeParse(declared);
  if (!parsed.success) throw new Error("onsite_mfa definition is invalid; refusing to log in without onsite verification");
  const places = parsed.data.allowed_place_ids;
  return {
    minAssurance: parsed.data.min_assurance,
    allowedPlaceIds: places ? [...new Set(places)].sort() : null,
  };
}
