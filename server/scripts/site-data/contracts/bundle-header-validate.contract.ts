import type { BundleHeader } from "../bundle-header.js";

const REJECTIONS = ["site-data: bundle_invalid", "site-data: service_mismatch", "site-data: format_unsupported"];

export default {
  post: (result: BundleHeader): true | string =>
    (result.service === "cernere" && result.formatVersion === 1 && /^[0-9a-f]{64}$/.test(result.dump.sha256))
    || "only cernere v1 headers may be accepted",
  postThrow: (error: unknown): true | string =>
    (error instanceof Error && REJECTIONS.some((prefix) => error.message.startsWith(prefix)))
    || "header rejection must be a classified site-data error",
};
