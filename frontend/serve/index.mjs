// cernere-frontend の本番配信 (excubitor.catalog.yaml)。setup がビルドした dist を配り、
// backend の経路だけ中継する。vite preview は本番用ではないため置き換えた (spec/setup/public-exposure.md)。
//   PORT (既定 5173) / HOST (既定 127.0.0.1: cloudflared だけが来る) / VITE_BACKEND_URL
import { createReadStream } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { bodyFraming, isBackendPath, isUpgradePath, proxyHttp, proxyUpgrade } from "./backend-proxy.mjs";
import { createFramePolicySource, fetchAllowedOrigins } from "./frame-policy.mjs";
import { parseRequestTarget } from "./request-target.mjs";
import { EXTRA_CSP, SECURITY_HEADERS } from "./security-headers.mjs";
import { buildStaticManifest, cacheControl, lookupStatic } from "./static-files.mjs";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const backend = new URL(process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8086");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "127.0.0.1";
// 配るファイルは起動時の dist で固定する (ビルドし直したら再起動する。deploy が行う)。
const manifest = buildStaticManifest(distDir);
const currentPolicy = createFramePolicySource(fetchAllowedOrigins(backend));

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  let csp;
  try { csp = `${await currentPolicy()}; ${EXTRA_CSP}`; } catch {
    return sendText(res, 503, "Login embedding policy is temporarily unavailable", { "Content-Security-Policy": "frame-ancestors 'none'" });
  }
  const entry = lookupStatic(manifest, pathname);
  if (!entry) return sendText(res, 404, "Not found", { "Content-Security-Policy": csp });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": csp,
    "Content-Type": entry.type,
    "Content-Length": entry.size,
    "Cache-Control": cacheControl(pathname, entry.spaFallback),
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(entry.file).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
  const target = parseRequestTarget(req.url);
  if (!target) return sendText(res, 400, "Bad request");
  if (isBackendPath(target.pathname)) return proxyHttp(req, res, backend, target.path);
  serveStatic(req, res, target.pathname).catch(() => {
    if (!res.headersSent) sendText(res, 500, "Internal server error");
    else res.destroy();
  });
});

server.on("upgrade", (req, socket, head) => {
  const target = parseRequestTarget(req.url);
  if (req.method !== "GET" || !target || !isUpgradePath(target.pathname) || bodyFraming(req.method, req.headers).reject) return socket.destroy();
  proxyUpgrade(req, socket, head, backend, target.path);
});

// ヘッダや本文を少しずつ送り続けて接続を占有する攻撃 (slowloris) を切る。WebSocket は upgrade 後なので対象外。
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.maxHeadersCount = 100;

server.listen(port, host, () => {
  console.log(`[cernere-frontend] serving ${manifest.size} files from ${distDir} on http://${host}:${port} (backend ${backend.origin})`);
});
