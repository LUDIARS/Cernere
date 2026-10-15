/**
 * サービスの同意宣言 (`schema_definition.consent`) と移行モード (`consent_mode`) の形。
 *
 * 形の検査だけを持つ (project/schema.ts から import されるため、上限との突き合わせや
 * 語彙の検査はここに置かない。それは consent/declaration.ts)。
 * spec/plan/2026-10-15-service-consent-design.md §3 / §6。
 */

import { z } from "zod";

export const CONSENT_LEVELS = ["required", "recommended"] as const;
export type ConsentLevel = (typeof CONSENT_LEVELS)[number];

/** サービスが申告できる公開範囲。`other_services` は Cernere が data_sharing から足すので書けない。 */
export const DECLARED_VISIBILITIES = ["self", "service_users", "public"] as const;
export type DeclaredVisibility = (typeof DECLARED_VISIBILITIES)[number];

export const CONSENT_MODES = ["off", "warn", "enforce"] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

/** 既定は off。全サービスで enforce にしたらここを変える (設計書 §6)。 */
export const DEFAULT_CONSENT_MODE: ConsentMode = "off";

export const consentModeSchema = z.enum(CONSENT_MODES);

/** 権限キーの形。語彙 (どの値が許されるか) は declaration.ts が見る。 */
const permissionKeySchema = z.string().min(3).max(160)
  .regex(/^[a-z_]+\.[A-Za-z0-9_:.-]+$/, "permission key must look like '<kind>.<name>'");

export const declaredPermissionSchema = z.object({
  key: permissionKeySchema,
  level: z.enum(CONSENT_LEVELS),
  purpose: z.string().trim().min(1, "purpose is required").max(400),
  visible_to: z.array(z.enum(DECLARED_VISIBILITIES)).min(1, "visible_to is required").max(DECLARED_VISIBILITIES.length),
}).strict();
export type DeclaredPermission = z.infer<typeof declaredPermissionSchema>;

export const consentDeclarationSchema = z.object({
  version: z.number().int().min(1).max(1_000_000),
  permissions: z.array(declaredPermissionSchema).max(100),
}).strict();
export type ConsentDeclaration = z.infer<typeof consentDeclarationSchema>;

/** 保存済み定義から consent_mode を読む。不正値・未設定は既定 (off)。 */
export function readConsentMode(value: unknown): ConsentMode {
  const parsed = consentModeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CONSENT_MODE;
}

/** 保存済み定義から宣言を読む。形が壊れていれば未宣言として扱う (§3.3 で全権限を推奨表示)。 */
export function readConsentDeclaration(value: unknown): ConsentDeclaration | null {
  const parsed = consentDeclarationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
