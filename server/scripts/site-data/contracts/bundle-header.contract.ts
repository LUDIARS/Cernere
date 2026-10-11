import type { BundleHeader, BundleHeaderInput } from "../bundle-header.js";

const SHA256 = /^[0-9a-f]{64}$/;
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

export default {
  post: (result: BundleHeader, input: BundleHeaderInput): true | string =>
    (result.service === "cernere"
      && result.formatVersion === 1
      && result.excluded.includes("redis")
      && SHA256.test(result.dump.sha256)
      && result.dump.sha256 === input.dumpSha256
      && isCount(result.dump.bytes)
      && Object.values(result.tables).every(isCount)
      && Object.keys(result.tables).length === Object.keys(input.tables).length)
    || "bundle header must identify cernere v1, exclude redis and carry a valid dump hash and row counts",
  postThrow: (error: unknown): true | string =>
    (error instanceof Error && error.message.startsWith("site-data: bundle_invalid")) || "invalid header input must fail as bundle_invalid",
};
