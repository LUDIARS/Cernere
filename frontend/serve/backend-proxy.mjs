// /api, /auth (WS), /ws/project (WS), /.well-known を backend へ中継する (vite.config.ts の proxy と同じ経路)。
// CF-Connecting-IP は正規化した 1 値だけを渡し、 backend が CERNERE_TRUSTED_PROXIES で信用する (server/src/http/client-ip.ts)。
import http from "node:http";
import net from "node:net";

const BACKEND_PREFIXES = ["/api", "/auth", "/ws/project", "/.well-known"];
const UPGRADE_PATHS = new Set(["/auth", "/auth/composite-ws", "/ws/project"]);
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];
/** 本文を持たないはずのメソッド。本文付きは区切りが曖昧になる (request desync) ので受けない。 */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

export function isBackendPath(pathname) {
  return BACKEND_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function isUpgradePath(pathname) {
  return UPGRADE_PATHS.has(pathname);
}

/** CF-Connecting-IP を 1 つの IP に詰め直す。複数値・IP でない値は捨てる (backend はソケットの相手を使う)。 */
export function normalizeClientIpHeader(value) {
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length !== 1 || typeof raw[0] !== "string") return undefined;
  const ip = raw[0].trim();
  return net.isIP(ip) ? ip : undefined;
}

/**
 * 本文の区切りを決める。Transfer-Encoding を落として Content-Length も無いまま流すと、
 * Node は GET 等で区切りを付けずに書き、backend は残りのバイトを次の要求として読む (request desync)。
 *   - 本文を持たないメソッドに本文が付いていれば拒否する
 *   - chunked で来た本文は chunked と明示して付け直す (Content-Length は使わない)
 *   - それ以外は Content-Length をそのまま使う
 */
export function bodyFraming(method, headers) {
  const chunked = headers["transfer-encoding"] !== undefined;
  const length = headers["content-length"];
  const hasBody = chunked || (length !== undefined && length !== "0");
  if (BODYLESS_METHODS.has(String(method).toUpperCase()) && hasBody) return { reject: true };
  return chunked ? { reject: false, headers: { "transfer-encoding": "chunked" }, dropLength: true } : { reject: false, headers: {}, dropLength: false };
}

/** hop-by-hop ヘッダを落とし、 Host を backend に向け (vite の changeOrigin と同じ)、 CF-Connecting-IP を詰め直す。 */
export function forwardHeaders(headers, backend) {
  const out = { ...headers, host: backend.host };
  for (const h of HOP_BY_HOP) delete out[h];
  const clientIp = normalizeClientIpHeader(headers["cf-connecting-ip"]);
  if (clientIp) out["cf-connecting-ip"] = clientIp;
  else delete out["cf-connecting-ip"];
  return out;
}

/** upgrade 要求を backend へ書き出す行。パスは parseRequestTarget で正規化したもの、Host は backend。 */
export function upgradeRequestHead(req, backend, path) {
  const headers = forwardHeaders(req.headers, backend);
  // WebSocket のハンドシェイクに要る hop-by-hop だけ戻す。本文の長さは持たせない。
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  delete headers["content-length"];
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined) lines.push(`${name}: ${v}`);
    }
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

const sendBadGateway = (res, status, text) => {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
};

/** path は parseRequestTarget で正規化したもの (生の req.url は使わない)。 */
export function proxyHttp(req, res, backend, path) {
  const framing = bodyFraming(req.method, req.headers);
  if (framing.reject) return sendBadGateway(res, 400, "Bad request");
  const headers = { ...forwardHeaders(req.headers, backend), ...framing.headers };
  if (framing.dropLength) delete headers["content-length"];
  const upstream = http.request({
    host: backend.hostname,
    port: backend.port || 80,
    method: req.method,
    path,
    headers,
    // 1 要求 1 接続。万一区切りがずれても、別の利用者の要求と同じ接続に混ざらない。
    agent: false,
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => sendBadGateway(res, 502, "Bad gateway"));
  // 利用者が途中で切ったら backend への要求も切る (半端な本文を backend に待たせない)。
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

/** WebSocket の upgrade は backend へつなぎ、 ハンドシェイクごと素通しする。 */
export function proxyUpgrade(req, socket, head, backend, path) {
  const upstream = net.connect(Number(backend.port || 80), backend.hostname, () => {
    upstream.write(upgradeRequestHead(req, backend, path));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
}
