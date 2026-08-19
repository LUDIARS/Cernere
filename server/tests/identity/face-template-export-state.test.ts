/**
 * export に pending が混ざらないことの回帰テスト。
 *
 * 実 DB を持たないので、export が組み立てた where 条件を PgDialect で SQL に
 * 落として `state = 'active'` の絞り込みが入っているかを見る。
 */

import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createFakeDb } from "./fake-drizzle.js";

const fake = createFakeDb();

vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/identity/face-template-crypto.js", () => ({
  createFaceTemplateDistributor: vi.fn(() => ({ keyId: "facility:test:v1", seal: (b: Buffer) => b })),
  openStoredFaceTemplate: vi.fn(() => Buffer.alloc(4)),
  sealStoredFaceTemplate: vi.fn(() => Buffer.alloc(4)),
}));

const { exportFaceTemplates } = await import("../../src/identity/face-template-store.js");

const FACILITY_ID = "22222222-2222-4222-8222-222222222222";

function renderedConditions(): string[] {
  const dialect = new PgDialect();
  return fake.selects.flatMap((select) => select.conditions.map((condition) => {
    const query = dialect.sqlToQuery(condition as never);
    return `${query.sql} :: ${JSON.stringify(query.params)}`;
  }));
}

describe("face template export state filter", () => {
  it("配布クエリに state='active' の絞り込みが入り、pending を配らない", async () => {
    await exportFaceTemplates(FACILITY_ID);
    const rendered = renderedConditions();
    const stateFiltered = rendered.filter((sql) => sql.includes('"state"') && sql.includes('"active"'));
    expect(stateFiltered.length).toBeGreaterThan(0);
  });
});
