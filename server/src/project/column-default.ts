/** Typed default values for project DDL. Never accepts an arbitrary SQL expression. */
import type { ColumnType } from "./schema.js";

function literal(value: string): string {
  // E literals make backslash handling explicit even when standard_conforming_strings is off.
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function serializeColumnDefault(value: string, type: ColumnType): string {
  if (typeof value !== "string" || value.length > 16384 || value.includes("\0")) throw new Error("Invalid default value");
  const trimmed = value.trim();
  switch (type) {
    case "integer":
    case "bigint": {
      if (!/^[+-]?\d+$/.test(trimmed)) throw new Error("Default must be an integer literal");
      const number = BigInt(trimmed);
      const min = type === "integer" ? -2147483648n : -9223372036854775808n;
      const max = type === "integer" ? 2147483647n : 9223372036854775807n;
      if (number < min || number > max) throw new Error("Integer default is out of range");
      return number.toString();
    }
    case "boolean":
      if (!/^(true|false)$/i.test(trimmed)) throw new Error("Default must be true or false");
      return trimmed.toLowerCase();
    case "json":
      try { JSON.parse(value); } catch { throw new Error("Default must be valid JSON"); }
      // Preserve the original numeric precision; parse only to validate JSON syntax.
      return `${literal(value)}::jsonb`;
    case "uuid":
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(trimmed)) {
        throw new Error("Default must be a UUID literal");
      }
      return `${literal(trimmed)}::uuid`;
    case "timestamp":
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
        || !Number.isFinite(Date.parse(trimmed))) throw new Error("Default must be an ISO timestamp with timezone");
      return `${literal(trimmed)}::timestamptz`;
    case "text": return literal(value);
    default: throw new Error("Unsupported default type");
  }
}
