import type { RowCountMismatch } from "../row-counts.js";

type Counts = Readonly<Record<string, number>>;

export default {
  post: (result: RowCountMismatch[], expected: Counts, actual: Counts): true | string => {
    const tables = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const differing = [...tables].filter((table) => expected[table] !== actual[table]);
    return (result.length === differing.length
      && result.every((entry) => differing.includes(entry.table)
        && entry.expected === (expected[entry.table] ?? null)
        && entry.actual === (actual[entry.table] ?? null)))
      || "every missing, extra or differing table must be reported exactly once";
  },
};
