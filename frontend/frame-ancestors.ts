import type { Plugin, Connect } from "vite";
import { frameAncestorsPolicy } from "./frame-ancestors-policy.mjs";

export { frameAncestorsPolicy };

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
