import { contract } from "@ludiars/log-weaver";
import buildContract from "./contracts/bundle-header.contract.js";
import validateContract from "./contracts/bundle-header-validate.contract.js";
import type { RowCounts } from "./row-counts.js";
import { SiteDataError } from "./site-data-error.js";

export const BUNDLE_SERVICE = "cernere";
export const BUNDLE_FORMAT_VERSION = 1;
/** Redis holds only 7-day session state; migrated sites force a fresh login. */
const EXCLUDED = ["redis"] as const;

export interface BundleHeader {
  service: typeof BUNDLE_SERVICE;
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  createdAt: string;
  postgres: { serverVersion: string; database: string };
  tables: Record<string, number>;
  dump: { format: "pg_dump-custom"; sha256: string; bytes: number };
  excluded: string[];
}

export interface BundleHeaderInput {
  createdAt: Date;
  serverVersion: string;
  database: string;
  tables: RowCounts;
  dumpSha256: string;
  dumpBytes: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isLabel = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

function isRowCounts(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.entries(value).every(([table, count]) => isLabel(table) && isCount(count));
}

function assembleBundleHeader(input: BundleHeaderInput): BundleHeader {
  if (Number.isNaN(input.createdAt.getTime()) || !isLabel(input.serverVersion) || !isLabel(input.database)
    || !isRowCounts(input.tables) || !SHA256.test(input.dumpSha256) || !isCount(input.dumpBytes)) {
    throw new SiteDataError("bundle_invalid", "header input");
  }
  return {
    service: BUNDLE_SERVICE,
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: input.createdAt.toISOString(),
    postgres: { serverVersion: input.serverVersion, database: input.database },
    tables: { ...input.tables },
    dump: { format: "pg_dump-custom", sha256: input.dumpSha256, bytes: input.dumpBytes },
    excluded: [...EXCLUDED],
  };
}

function checkBundleHeader(value: unknown): BundleHeader {
  if (!isRecord(value)) throw new SiteDataError("bundle_invalid", "header is not an object");
  if (value.service !== BUNDLE_SERVICE) throw new SiteDataError("service_mismatch");
  if (value.formatVersion !== BUNDLE_FORMAT_VERSION) throw new SiteDataError("format_unsupported");
  const { postgres, dump } = value;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
    || !isRecord(postgres) || !isLabel(postgres.serverVersion) || !isLabel(postgres.database)
    || !isRowCounts(value.tables)
    || !isRecord(dump) || dump.format !== "pg_dump-custom" || typeof dump.sha256 !== "string"
    || !SHA256.test(dump.sha256) || !isCount(dump.bytes)
    || !Array.isArray(value.excluded) || !value.excluded.every(isLabel)) {
    throw new SiteDataError("bundle_invalid", "header fields");
  }
  return value as unknown as BundleHeader;
}

export const buildBundleHeader = contract(assembleBundleHeader, {
  ...buildContract, contractId: "C-19", mode: "observe", sample: 1,
  where: "server/scripts/site-data/bundle-header.ts", rule: "contract-wrap", id: "bundle-header",
});

export const validateBundleHeader = contract(checkBundleHeader, {
  ...validateContract, contractId: "C-20", mode: "observe", sample: 1,
  where: "server/scripts/site-data/bundle-header.ts", rule: "contract-wrap", id: "bundle-header-validate",
});
