/**
 * face 系ストアのテスト用の最小 drizzle モック。
 *
 * 実 DB を立てずに「どのテーブルを消したか」「where にどんな条件を積んだか」を
 * 観測するためだけのもの。クエリの意味論は再現しない。
 */

import { vi } from "vitest";

export interface FakeQuery {
  table: unknown;
  conditions: unknown[];
}

export interface FakeDb {
  db: Record<string, unknown>;
  selects: FakeQuery[];
  deletes: FakeQuery[];
  inserts: Array<{ table: unknown; values: unknown }>;
  updates: Array<{ table: unknown; values: unknown }>;
  /** select の戻り値を FIFO で与える。尽きたら [] を返す。 */
  queueSelect: (rows: unknown[]) => void;
}

export function createFakeDb(): FakeDb {
  const selects: FakeQuery[] = [];
  const deletes: FakeQuery[] = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const selectQueue: unknown[][] = [];

  const chain = (record: FakeQuery, rows: () => unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "limit", "orderBy"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.where = vi.fn((condition: unknown) => {
      record.conditions.push(condition);
      return builder;
    });
    builder.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows()).then(resolve, reject);
    return builder;
  };

  const db: Record<string, unknown> = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => {
      const record: FakeQuery = { table: null, conditions: [] };
      selects.push(record);
      const builder = chain(record, () => selectQueue.shift() ?? []);
      const from = builder.from as ReturnType<typeof vi.fn>;
      from.mockImplementation((table: unknown) => { record.table = table; return builder; });
      return builder;
    }),
    delete: vi.fn((table: unknown) => {
      const record: FakeQuery = { table, conditions: [] };
      deletes.push(record);
      return chain(record, () => []);
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return Promise.resolve();
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        updates.push({ table, values });
        const record: FakeQuery = { table, conditions: [] };
        return chain(record, () => []);
      }),
    })),
  };
  db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db));

  return {
    db,
    selects,
    deletes,
    inserts,
    updates,
    queueSelect: (rows: unknown[]) => { selectQueue.push(rows); },
  };
}
