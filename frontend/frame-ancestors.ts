import type { Plugin, Connect } from "vite";

/** @implements SPEC-EMBEDDED-COMPOSITE-001 */
export function frameAncestorsPolicy(origins: unknown): string {
  if (!Array.isArray(origins) || origins.length === 0) throw new Error("Missing embedding allowlist");
  const sources = origins.map((origin: unknown) => {
    if (typeof origin !== "string") throw new Error("Invalid embedding origin");
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Invalid embedding origin");
    return origin;
  });
  return `frame-ancestors 'self' ${[...new Set(sources)].join(" ")}`;
}

/** Protect every served document, including registration/recovery after frame navigation.
 * @implements SPEC-EMBEDDED-COMPOSITE-001
 */
export function compositeFramePolicy(backendUrl: string): Plugin {
  const middleware: Connect.NextHandleFunction = (_req, res, next) => {
    void (async () => {
      try {
        const response = await fetch(new URL("/api/auth/composite/allowed-origins", backendUrl), {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Embedding policy unavailable");
        const body = await response.json() as { origins?: unknown };
        res.setHeader("Content-Security-Policy", frameAncestorsPolicy(body.origins));
        next();
      } catch {
        res.statusCode = 503;
        res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        res.setHeader("Cache-Control", "no-store");
        res.end("Login embedding policy is temporarily unavailable");
      }
    })();
  };
  return {
    name: "composite-frame-policy",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
