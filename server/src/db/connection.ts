/**
 * PostgreSQL 接続 (Drizzle ORM + postgres.js)
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

const client = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
});

export const db = drizzle(client, { schema });
export type Database = typeof db;

console.log("[db] PostgreSQL connection pool created");
