/** template version 採番の transaction-scoped 直列化契約。 */

import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createFakeDb } from "./fake-drizzle.js";

const { lockFaceTemplateVersion } = await import("../../src/identity/face-template-versioning.js");

describe("lockFaceTemplateVersion", () => {
  it("user/facility 固有の PostgreSQL advisory transaction lock を取得する", async () => {
    const fake = createFakeDb();
    await lockFaceTemplateVersion("user-a", "facility-a", fake.db as never);

    const execute = fake.db.execute as ReturnType<typeof vi.fn>;
    const condition = execute.mock.calls[0][0];
    const rendered = new PgDialect().sqlToQuery(condition as never);
    expect(rendered.sql).toContain("pg_advisory_xact_lock");
    expect(rendered.params).toContain("face-template:user-a:facility-a");
  });
});
