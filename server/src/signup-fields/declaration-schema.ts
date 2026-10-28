/**
 * サービスがログイン時に聞く入力項目の宣言 (`schema_definition.signup_fields`) の形。
 *
 * 形の検査だけを持つ (project/schema.ts から import されるため、列定義や consent との突き合わせは
 * ここに置かない。それは signup-fields/declaration.ts)。
 * spec/plan/2026-10-15-service-signup-fields-design.md §2。
 */

import { z } from "zod";

export const SIGNUP_FIELD_INPUTS = ["text", "textarea", "select", "tabs", "boolean", "number"] as const;
export type SignupFieldInput = (typeof SIGNUP_FIELD_INPUTS)[number];

export const MAX_SIGNUP_FIELDS = 20;
export const MAX_SIGNUP_OPTIONS = 50;
export const MAX_SIGNUP_LABEL = 40;
/** max_length を宣言しない text / textarea の上限 */
export const DEFAULT_TEXT_MAX_LENGTH = 200;
export const DEFAULT_TEXTAREA_MAX_LENGTH = 2000;

const optionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(100),
}).strict();

export const signupFieldSchema = z.object({
  /** 保存先 project (共有を受けている列、設計書 §8)。省略時は自分の project の列 */
  project: z.string().min(1).max(128).optional(),
  column: z.string().min(1).max(128),
  label: z.string().trim().min(1, "label is required").max(MAX_SIGNUP_LABEL),
  required: z.boolean().default(false),
  input: z.enum(SIGNUP_FIELD_INPUTS),
  max_length: z.number().int().min(1).max(DEFAULT_TEXTAREA_MAX_LENGTH).optional(),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(400).optional(),
  options: z.array(optionSchema).min(1).max(MAX_SIGNUP_OPTIONS).optional(),
  visible_when: z.object({ column: z.string().min(1).max(128), value: z.string().min(1).max(100) }).strict().optional(),
  minimum: z.number().int().optional(),
}).strict().superRefine((field, context) => {
  if ((field.input === "select" || field.input === "tabs") && !field.options) {
    context.addIssue({ code: "custom", path: ["options"], message: "select needs options" });
  }
  if (field.input !== "select" && field.input !== "tabs" && field.options) {
    context.addIssue({ code: "custom", path: ["options"], message: "options are only for select" });
  }
  if (field.minimum !== undefined && field.input !== "number") {
    context.addIssue({ code: "custom", path: ["minimum"], message: "minimum is only for number" });
  }
  if (field.max_length !== undefined && field.input !== "text" && field.input !== "textarea") {
    context.addIssue({ code: "custom", path: ["max_length"], message: "max_length is only for text / textarea" });
  }
});
export type SignupField = z.infer<typeof signupFieldSchema>;

export const signupFieldsDeclarationSchema = z.object({
  version: z.number().int().min(1).max(1_000_000),
  fields: z.array(signupFieldSchema).max(MAX_SIGNUP_FIELDS),
}).strict();
export type SignupFieldsDeclaration = z.infer<typeof signupFieldsDeclarationSchema>;

/** 保存済み定義から宣言を読む。形が壊れていれば未宣言 (入力を求めない)。 */
export function readSignupFieldsDeclaration(value: unknown): SignupFieldsDeclaration | null {
  const parsed = signupFieldsDeclarationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** text / textarea の実際の上限。 */
export function textLimitOf(field: Pick<SignupField, "input" | "max_length">): number {
  return field.max_length ?? (field.input === "textarea" ? DEFAULT_TEXTAREA_MAX_LENGTH : DEFAULT_TEXT_MAX_LENGTH);
}
