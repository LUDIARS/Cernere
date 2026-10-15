/**
 * 「<サービス名> で使う情報」の入力欄 (spec/plan/2026-10-15-service-signup-fields-design.md §4)。
 * /consent・オンボーディング・サービスの権限で共用する。描画と項目ごとのエラー表示だけを持ち、送信は呼び出し側。
 *
 * - 宣言の順に並べ、必須に印を付ける
 * - 各欄に「誰が読めるか」(その列の module の consent 宣言。無ければ「このサービス」)
 */

import type { CSSProperties } from "react";
import type { SignupFieldErrors, SignupFieldValue, SignupFieldView, SignupFieldVisibility } from "../../lib/signup-fields-api";
import { audienceLabel } from "../consent/consent-labels";

const fieldStyle: CSSProperties = { padding: "0.55rem 0", borderTop: "1px solid var(--border)", fontSize: "0.85rem" };
const inputStyle: CSSProperties = {
  width: "100%", padding: "0.45rem 0.6rem", marginTop: "0.3rem", boxSizing: "border-box",
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
};
const noteStyle: CSSProperties = { color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.2rem" };

function visibilityText(visibleTo: SignupFieldVisibility[] | null): string {
  if (!visibleTo || visibleTo.length === 0) return "このサービス";
  return visibleTo.map((audience) => audienceLabel({ audience, source: "service" })).join(" / ");
}

function FieldInput(props: {
  field: SignupFieldView;
  value: SignupFieldValue;
  invalid: boolean;
  disabled?: boolean;
  onChange: (value: SignupFieldValue) => void;
}) {
  const { field, value, invalid, disabled, onChange } = props;
  const id = `signup-field-${field.column}`;
  const style = invalid ? { ...inputStyle, borderColor: "var(--red)" } : inputStyle;
  const common = { id, disabled, "aria-invalid": invalid, "aria-required": field.required };
  switch (field.input) {
    case "textarea":
      return <textarea {...common} rows={3} maxLength={field.maxLength ?? undefined} placeholder={field.placeholder ?? undefined}
        value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} style={style} />;
    case "select":
      return (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} style={style}>
          <option value="">選んでください</option>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "boolean":
      return (
        <select {...common} value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")} style={style}>
          <option value="">選んでください</option>
          <option value="true">はい</option>
          <option value="false">いいえ</option>
        </select>
      );
    case "number":
      return <input {...common} type="number" inputMode="numeric" step={1} placeholder={field.placeholder ?? undefined}
        value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} style={style} />;
    default:
      return <input {...common} type="text" maxLength={field.maxLength ?? undefined} placeholder={field.placeholder ?? undefined}
        value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} style={style} />;
  }
}

export function SignupFieldsForm(props: {
  serviceName: string;
  fields: readonly SignupFieldView[];
  values: Record<string, SignupFieldValue>;
  errors?: SignupFieldErrors;
  disabled?: boolean;
  onChange: (column: string, value: SignupFieldValue) => void;
}) {
  const { serviceName, fields, values, errors, disabled, onChange } = props;
  if (fields.length === 0) return null;
  return (
    <div style={{ marginBottom: "1rem" }}>
      <p style={{ fontSize: "0.85rem", fontWeight: 600, margin: "0 0 0.25rem" }}>{serviceName} で使う情報</p>
      {fields.map((field) => {
        const error = errors?.[field.column];
        return (
          <div key={field.column} style={fieldStyle}>
            <label htmlFor={`signup-field-${field.column}`} style={{ fontWeight: 600 }}>
              {field.label}
              {field.required && <span style={{ color: "var(--red)", marginLeft: "0.3rem" }} aria-label="必須">*</span>}
            </label>
            <FieldInput field={field} value={values[field.column] ?? null} invalid={!!error} disabled={disabled}
              onChange={(value) => onChange(field.column, value)} />
            {error && <div role="alert" style={{ color: "var(--red)", fontSize: "0.78rem", marginTop: "0.2rem" }}>{error}</div>}
            {field.help && <div style={noteStyle}>{field.help}</div>}
            <div style={noteStyle}>誰が読めるか: {visibilityText(field.visibleTo)}</div>
          </div>
        );
      })}
      <p style={noteStyle}><span style={{ color: "var(--red)" }}>*</span> は必須です。</p>
    </div>
  );
}
