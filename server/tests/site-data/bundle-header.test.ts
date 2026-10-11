import { describe, expect, it } from "vitest";
import { buildBundleHeader, validateBundleHeader } from "../../scripts/site-data/bundle-header.js";
import { COUNTS, NOW } from "./fakes.js";

const input = { createdAt: NOW, serverVersion: "17.9", database: "cernere", tables: COUNTS, dumpSha256: "a".repeat(64), dumpBytes: 10 };

describe("bundle header", () => {
  it("identifies cernere v1, records counts and the dump hash, and excludes redis", () => {
    const header = buildBundleHeader(input);
    expect(header).toEqual({
      service: "cernere", formatVersion: 1, createdAt: "2026-10-11T12:34:56.789Z",
      postgres: { serverVersion: "17.9", database: "cernere" }, tables: COUNTS,
      dump: { format: "pg_dump-custom", sha256: "a".repeat(64), bytes: 10 }, excluded: ["redis"],
    });
    expect(validateBundleHeader(JSON.parse(JSON.stringify(header)))).toEqual(header);
  });

  it.each([
    ["uppercase hash", { dumpSha256: "A".repeat(64) }],
    ["negative count", { tables: { "public.users": -1 } }],
    ["fractional bytes", { dumpBytes: 1.5 }],
  ])("rejects invalid input (%s)", (_name, patch) => {
    expect(() => buildBundleHeader({ ...input, ...patch })).toThrow(/^site-data: bundle_invalid/);
  });

  it("rejects another service, an unknown format version and missing fields", () => {
    const header = buildBundleHeader(input);
    expect(() => validateBundleHeader({ ...header, service: "glab" })).toThrow(/^site-data: service_mismatch/);
    expect(() => validateBundleHeader({ ...header, formatVersion: 2 })).toThrow(/^site-data: format_unsupported/);
    expect(() => validateBundleHeader({ ...header, dump: { ...header.dump, sha256: "zz" } })).toThrow(/^site-data: bundle_invalid/);
    expect(() => validateBundleHeader({ ...header, tables: undefined })).toThrow(/^site-data: bundle_invalid/);
    expect(() => validateBundleHeader(null)).toThrow(/^site-data: bundle_invalid/);
  });
});
