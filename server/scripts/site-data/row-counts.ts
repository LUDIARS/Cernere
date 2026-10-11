import { contract } from "@ludiars/log-weaver";
import rowCountsContract from "./contracts/row-counts.contract.js";

export type RowCounts = Readonly<Record<string, number>>;

export interface RowCountMismatch {
  table: string;
  expected: number | null;
  actual: number | null;
}

function diffRowCounts(expected: RowCounts, actual: RowCounts): RowCountMismatch[] {
  const tables = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return tables
    .filter((table) => expected[table] !== actual[table])
    .map((table) => ({ table, expected: expected[table] ?? null, actual: actual[table] ?? null }));
}

export const compareRowCounts = contract(diffRowCounts, {
  ...rowCountsContract, contractId: "C-21", mode: "observe", sample: 1,
  where: "server/scripts/site-data/row-counts.ts", rule: "contract-wrap", id: "row-counts",
});

/** Table names only; row data never appears in diagnostics. */
export function describeMismatches(mismatches: readonly RowCountMismatch[]): string {
  const shown = mismatches.slice(0, 5).map((m) => `${m.table}: ${m.expected ?? "absent"} -> ${m.actual ?? "absent"}`);
  return mismatches.length > shown.length ? `${shown.join(", ")}, +${mismatches.length - shown.length} more` : shown.join(", ");
}
