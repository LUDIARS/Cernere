// Composite 埋め込みの frame-ancestors を許可リストから組み立てる (SPEC-EMBEDDED-COMPOSITE-001)。
// vite のプラグイン (frame-ancestors.ts) と本番配信 (serve/frame-policy.mjs) の両方が使う。
// 本番配信は Node が .ts を読めない版 (22.12〜22.17) でも動くよう、ここは素の JavaScript にしておく。

/**
 * @param {unknown} origins
 * @returns {string}
 * @implements SPEC-EMBEDDED-COMPOSITE-001
 */
export function frameAncestorsPolicy(origins) {
  if (!Array.isArray(origins) || origins.length === 0) throw new Error("Missing embedding allowlist");
  const sources = origins.map((origin) => {
    if (typeof origin !== "string") throw new Error("Invalid embedding origin");
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Invalid embedding origin");
    return origin;
  });
  return `frame-ancestors 'self' ${[...new Set(sources)].join(" ")}`;
}
