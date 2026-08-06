/** Minimal postgres.js surface needed to bind an explicit JSONB parameter. */
export interface JsonParameterFactory {
  json(value: unknown): unknown;
}

/**
 * Bind managed-project values without double-encoding JSON.
 *
 * postgres.js needs an explicit JSONB parameter marker for arrays; passing an
 * array directly is inferred as a PostgreSQL array, while JSON.stringify()
 * makes the driver encode a JSON string. sql.json() preserves the JSON shape.
 */
export function toUserDataParameter(
  sqlClient: JsonParameterFactory,
  value: unknown,
  columnType: string,
): unknown {
  return columnType === "json" || columnType === "jsonb"
    ? sqlClient.json(value)
    : value;
}
