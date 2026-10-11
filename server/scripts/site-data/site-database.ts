import postgres from "postgres";
import { databaseUrlFor } from "./database-url.js";
import { quoteDatabaseName } from "./identifiers.js";
import type { RowCounts } from "./row-counts.js";

/** SQL-side operations of export/import. Injected so the procedures can be tested without a server. */
export interface SiteDatabase {
  serverVersion(): Promise<string>;
  rowCounts(database: string): Promise<RowCounts>;
  databaseExists(name: string): Promise<boolean>;
  renameDatabase(from: string, to: string): Promise<void>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
}

const MAINTENANCE_DATABASE = "postgres";

/** One short-lived connection per call: a lingering session would block RENAME / DROP DATABASE. */
export function createSiteDatabase(databaseUrl: string): SiteDatabase {
  async function withConnection<T>(database: string, work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(databaseUrlFor(databaseUrl, database), {
      max: 1, connect_timeout: 15, idle_timeout: 1, onnotice: () => undefined,
    });
    try {
      return await work(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const maintenance = (statement: string) =>
    withConnection(MAINTENANCE_DATABASE, async (sql) => { await sql.unsafe(statement); });

  return {
    serverVersion: () => withConnection(MAINTENANCE_DATABASE, async (sql) => {
      const [row] = await sql<{ server_version: string }[]>`SHOW server_version`;
      return row.server_version;
    }),
    rowCounts: (database) => withConnection(database, async (sql) => {
      const tables = await sql<{ table_schema: string; table_name: string }[]>`
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_schema NOT LIKE 'pg_toast%'
        ORDER BY table_schema, table_name`;
      const counts: Record<string, number> = {};
      for (const { table_schema: schema, table_name: table } of tables) {
        const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql(schema)}.${sql(table)}`;
        counts[`${schema}.${table}`] = Number(row.n);
      }
      return counts;
    }),
    databaseExists: (name) => withConnection(MAINTENANCE_DATABASE, async (sql) => {
      const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
      return rows.length > 0;
    }),
    renameDatabase: (from, to) => maintenance(`ALTER DATABASE ${quoteDatabaseName(from)} RENAME TO ${quoteDatabaseName(to)}`),
    createDatabase: (name) => maintenance(`CREATE DATABASE ${quoteDatabaseName(name)}`),
    dropDatabase: (name) => maintenance(`DROP DATABASE IF EXISTS ${quoteDatabaseName(name)}`),
  };
}
