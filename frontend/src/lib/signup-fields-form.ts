/** Pure form-state helpers for declared signup fields. */
export type SignupFieldValue = string | number | boolean | null;

export interface SignupFieldFormView {
  column: string;
  required: boolean;
  visibleWhen?: { column: string; value: string };
  minimum?: number;
  options: Array<{ value: string; label: string }> | null;
  value: SignupFieldValue;
}

/** Form initial values (the current stored values, or null when empty). */
export function initialSignupValues(fields: readonly SignupFieldFormView[]): Record<string, SignupFieldValue> {
  return Object.fromEntries(fields.map((field) => [field.column, field.value]));
}

/** Whether a field is active for the selector values currently in the form. */
export function isSignupFieldVisible(
  field: SignupFieldFormView,
  values: Readonly<Record<string, SignupFieldValue>>,
): boolean {
  return !field.visibleWhen || values[field.visibleWhen.column] === field.visibleWhen.value;
}

/** Client-side submit guard. The server remains the final authority. */
export function requiredFilled(
  fields: readonly SignupFieldFormView[],
  values: Readonly<Record<string, SignupFieldValue>>,
): boolean {
  return fields.every((field) => {
    if (!isSignupFieldVisible(field, values) || !field.required) return true;
    const value = values[field.column];
    if (field.options && !field.options.some((option) => option.value === value)) return false;
    if (field.minimum !== undefined) {
      const number = typeof value === "number"
        ? value
        : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
      if (!Number.isSafeInteger(number) || number < field.minimum) return false;
    }
    return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
  });
}
