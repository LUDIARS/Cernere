// /api, /auth (WS), /ws/project (WS), /.well-known を backend へ中継する (vite.config.ts の proxy と同じ経路)。
// CF-Connecting-IP はそのまま渡し、 backend が CERNERE_TRUSTED_PROXIES で信用する (server/src/http/client-ip.ts)。
import http from "node:http";
import net from "node:net";

const BACKEND_PREFIXES = ["/api", "/auth", "/ws/project", "/.well-known"];
const UPGRADE_PATHS = new Set(["/auth", "/auth/composite-ws", "/ws/project"]);
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];

export function isBackendPath(pathname) {
  return BACKEND_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function isUpgradePath(pathname) {
  return UPGRADE_PATHS.has(pathname);
}

/** hop-by-hop ヘッダを落とし、 Host を backend に向ける (vite の changeOrigin と同じ)。 */
export function forwardHeaders(headers, backend) {
  const out = { ...headers, host: backend.host };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

/** upgrade 要求を backend へ書き出す行。パスは parseRequestTarget で正規化したもの、Host は backend。 */
export function upgradeRequestHead(req, backend, path) {
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries({ ...req.headers, host: backend.host })) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined) lines.push(`${name}: ${v}`);
    }
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

/** path は parseRequestTarget で正規化したもの (生の req.url は使わない)。 */
export function proxyHttp(req, res, backend, path) {
  const upstream = http.request({
    host: backend.hostname,
    port: backend.port || 80,
    method: req.method,
    path,
    headers: forwardHeaders(req.headers, backend),
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Bad gateway");
  });
  req.pipe(upstream);
}

/** WebSocket の upgrade は生のソケットを backend へつなぎ、 ハンドシェイクごと素通しする。 */
export function proxyUpgrade(req, socket, head, backend, path) {
  const upstream = net.connect(Number(backend.port || 80), backend.hostname, () => {
    upstream.write(upgradeRequestHead(req, backend, path));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
}
