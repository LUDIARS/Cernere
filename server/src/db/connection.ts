/**
 * PostgreSQL 接続 (Drizzle ORM + postgres.js)
 *
 * dev モードでは全 SQL クエリを stdout に流す (drizzleDevLogger)。
 * postgres.js 側のエラー / notice もコールバックで補足し、500 エラーの
 * 一次切り分けに使う。
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import { drizzleDevLogger, devLog, devError, DEV_LOG_ENABLED } from "../logging/dev-logger.js";
import * as schema from "./schema.js";

const client = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  // dev は接続イベントを詳細に追う
  debug: DEV_LOG_ENABLED
    ? (connection, query, params) => {
        const paramsStr = params.length > 0 ? ` -- params: ${JSON.stringify(params)}` : "";
        console.log(`[db.raw conn=${connection}] ${query}${paramsStr}`);
      }
    : undefined,
  onnotice: (notice) => {
    devLog("db.notice", { severity: notice.severity, message: notice.message });
  },
});

export const db = drizzle(client, { schema, logger: drizzleDevLogger });
export type Database = typeof db;

console.log(
  `[db] PostgreSQL connection pool created (queryLog=${DEV_LOG_ENABLED ? "on" : "off"})`,
);

/** 起動時の疎通確認 (dev のみ ping を打って失敗を即可視化) */
if (DEV_LOG_ENABLED) {
  client`SELECT 1 AS ok`.then(
    () => devLog("db.ping.ok"),
    (err) => devError("db.ping.failed", err),
  );
}
